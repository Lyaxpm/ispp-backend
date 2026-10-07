import { Worker, Job, ConnectionOptions } from 'bullmq';
import { Logger } from '@nestjs/common';
import { OnuStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
// Kontrak: disediakan modul network (agen lain).
import { DriverFactory } from '../network/drivers/driver-factory';
import { OltDriver } from '../network/drivers/network-driver.interface';
import { GisFtthService } from '../services/gis-ftth.service';

/**
 * Worker monitoring optik FTTH (BullMQ).
 *
 * Job yang didukung:
 * - { kind: 'optical-poll' }: poll daya optik semua ONU ONLINE/DEGRADED di
 *   OLT yang ACTIVE. Klasifikasi: rxDbm < -27 -> DEGRADED; status 'los' ->
 *   LOS. Alarm per-ONU di-throttle 1 jam via Setting. Mass LOS (>=30% ONU
 *   satu PON port LOS dalam 10 menit terakhir) -> impact engine + notif WA.
 * - { kind: 'discover-unconfigured', oltId }: scan ONU belum terkonfigurasi.
 *
 * Integrasi Telegram/NOC:
 * Integrator (agen yang memiliki TelegramService) cukup mengimplementasikan
 * interface NocAlerter di bawah dan meneruskannya sebagai deps.alerter —
 * worker ini tidak mengimpor TelegramService secara langsung.
 *
 * Contoh penjadwalan (sudah ada di workers/queues.ts milik agen scheduler):
 *   monitoring queue: 'optical-poll' tiap 15 menit ({ kind: 'optical-poll' }).
 * Panggil createOpticalMonitoringWorker(connection, deps, 'monitoring').
 */

export interface NocAlerter {
  sendNocAlarm(message: string): Promise<void>;
}

export interface OpticalMonitoringDeps {
  prisma: PrismaService;
  factory: DriverFactory;
  gis: GisFtthService;
  alerter: NocAlerter;
}

export type OpticalJobData =
  | { kind: 'optical-poll' }
  | { kind: 'discover-unconfigured'; oltId: number };

const ONU_CONCURRENCY = 3;
const DEGRADED_RX_DBM = -27;
const MASS_LOS_RATIO = 0.3;
const MASS_LOS_WINDOW_MIN = 10;
const PER_ONU_ALARM_THROTTLE_MIN = 60;

const logger = new Logger('OpticalMonitoringWorker');

async function getSetting(
  prisma: PrismaService,
  key: string,
): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null);
  return row ? String((row as { value: string }).value) : null;
}

async function setSetting(
  prisma: PrismaService,
  key: string,
  value: string,
): Promise<void> {
  await prisma.setting
    .upsert({ where: { key }, update: { value }, create: { key, value } })
    .catch((err) => logger.warn(`Gagal simpan setting ${key}: ${(err as Error).message}`));
}

/** Jalankan fn untuk items dengan konkurensi terbatas, tahan terhadap error per-item. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        logger.error(`Item #${i} gagal: ${(err as Error).message}`);
        results[i] = undefined as R;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

interface OnuRow {
  id: number;
  sn: string;
  oltId: number | null;
  ponPortId: number | null;
  ontId: string | null;
  status: OnuStatus;
  ponPort: { name: string } | null;
}

async function handleOpticalPoll(deps: OpticalMonitoringDeps): Promise<void> {
  const { prisma, factory, gis, alerter } = deps;

  const onus = (await prisma.onu.findMany({
    where: {
      status: { in: [OnuStatus.ONLINE, OnuStatus.DEGRADED] },
      olt: { status: 'ACTIVE' },
    },
    select: {
      id: true,
      sn: true,
      oltId: true,
      ponPortId: true,
      ontId: true,
      status: true,
      ponPort: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  })) as unknown as OnuRow[];

  logger.log(`Optical poll: ${onus.length} ONU di-scan.`);

  // Kelompokkan per OLT agar driver dipakai ulang.
  const byOlt = new Map<number, OnuRow[]>();
  for (const onu of onus) {
    if (onu.oltId == null) continue;
    const list = byOlt.get(onu.oltId) ?? [];
    list.push(onu);
    byOlt.set(onu.oltId, list);
  }

  for (const [oltId, list] of byOlt) {
    let driver: OltDriver;
    try {
      driver = await factory.getOltDriver(oltId);
    } catch (err) {
      logger.error(`OLT id=${oltId}: gagal ambil driver — ${(err as Error).message}`);
      continue;
    }

    await mapWithConcurrency(list, ONU_CONCURRENCY, async (onu) => {
      const ponName = onu.ponPort?.name;
      const ontIdNum = Number(onu.ontId);
      if (!ponName || !Number.isInteger(ontIdNum)) {
        logger.warn(`ONU ${onu.sn}: ponPort/ontId tidak valid, dilewati.`);
        return;
      }
      let rxDbm: number | null = null;
      let txDbm: number | null = null;
      let devStatus: 'online' | 'offline' | 'los' = 'offline';
      try {
        const power = await driver.getOnuOpticalPower(ponName, ontIdNum);
        rxDbm = power.rxDbm ?? null;
        txDbm = power.txDbm ?? null;
        devStatus = await driver.getOnuStatus(ponName, ontIdNum);
      } catch (err) {
        logger.warn(`ONU ${onu.sn} (${ponName}/${ontIdNum}): ${(err as Error).message}`);
        return;
      }

      const now = new Date();
      let newStatus: OnuStatus = onu.status;
      if (devStatus === 'los') newStatus = OnuStatus.LOS;
      else if (devStatus === 'offline') newStatus = OnuStatus.OFFLINE;
      else newStatus = rxDbm != null && rxDbm < DEGRADED_RX_DBM ? OnuStatus.DEGRADED : OnuStatus.ONLINE;

      await prisma.onu
        .update({
          where: { id: onu.id },
          data: { rxPower: rxDbm, txPower: txDbm, status: newStatus, lastSeen: now },
        })
        .catch((err) => logger.warn(`Gagal update ONU ${onu.sn}: ${(err as Error).message}`));

      // Alarm LOS: langsung. Alarm DEGRADED: throttle 1 jam per ONU.
      if (newStatus === OnuStatus.LOS) {
        await alerter
          .sendNocAlarm(
            `🔴 LOS terdeteksi\nONU: ${onu.sn}\nPON: ${ponName}/${ontIdNum}\nWaktu: ${now.toISOString()}`,
          )
          .catch((err) => logger.warn(`Gagal kirim alarm LOS: ${(err as Error).message}`));
      } else if (newStatus === OnuStatus.DEGRADED) {
        const key = `OPTICAL_ALARM_ONU_${onu.id}`;
        const last = await getSetting(prisma, key);
        const elapsedMin = last ? (Date.now() - new Date(last).getTime()) / 60000 : Infinity;
        if (elapsedMin >= PER_ONU_ALARM_THROTTLE_MIN) {
          await alerter
            .sendNocAlarm(
              `🟡 Sinyal optik lemah (DEGRADED)\nONU: ${onu.sn}\nRX: ${rxDbm} dBm (ambang ${DEGRADED_RX_DBM} dBm)\nPON: ${ponName}/${ontIdNum}`,
            )
            .catch((err) => logger.warn(`Gagal kirim alarm DEGRADED: ${(err as Error).message}`));
          await setSetting(prisma, key, now.toISOString());
        }
      }
    });
  }

  await detectMassLos(deps);
}

/**
 * Deteksi fiber break massal: bila >=30% ONU pada satu PON port berstatus
 * LOS dengan lastSeen dalam 10 menit terakhir -> impact engine + notif WA.
 */
async function detectMassLos(deps: OpticalMonitoringDeps): Promise<void> {
  const { prisma, gis, alerter } = deps;
  const windowStart = new Date(Date.now() - MASS_LOS_WINDOW_MIN * 60 * 1000);

  const ponPorts = await prisma.ponPort.findMany({
    select: { id: true, name: true, olt: { select: { name: true } } },
  });

  for (const pon of ponPorts) {
    const total = await prisma.onu.count({ where: { ponPortId: pon.id } });
    if (total === 0) continue;
    const losCount = await prisma.onu.count({
      where: { ponPortId: pon.id, status: OnuStatus.LOS, lastSeen: { gte: windowStart } },
    });
    const ratio = losCount / total;
    if (losCount > 0 && ratio >= MASS_LOS_RATIO) {
      const label = `PON ${pon.name} @ ${(pon.olt as { name: string } | null)?.name ?? '?'}`;
      logger.error(
        `MASS LOS: ${label} — ${losCount}/${total} ONU LOS (${Math.round(ratio * 100)}%).`,
      );
      try {
        const impact = await gis.calculateOutageImpact('PON_PORT', pon.id);
        const notify = await gis.notifyOutageImpact(impact);
        await alerter.sendNocAlarm(
          `🔴🔴 MASS LOS\n${label}\n${losCount}/${total} ONU LOS dalam ${MASS_LOS_WINDOW_MIN} menit.\n` +
            `Estimasi ${impact.totalCustomers} pelanggan terdampak di ${impact.affectedOdpCount} ODP.\n` +
            `Notifikasi WA terkirim ke ${notify.notified} nomor.`,
        );
      } catch (err) {
        logger.error(`Gagal proses mass LOS ${label}: ${(err as Error).message}`);
      }
    }
  }
}

async function handleDiscoverUnconfigured(
  deps: OpticalMonitoringDeps,
  oltId: number,
): Promise<unknown> {
  const { factory } = deps;
  const driver = await factory.getOltDriver(oltId);
  const found = await driver.discoverUnconfiguredOnus();
  const count = Array.isArray(found) ? found.length : 0;
  logger.log(`Discover OLT id=${oltId}: ${count} ONU belum terkonfigurasi.`);
  return found;
}

export function createOpticalMonitoringWorker(
  connection: ConnectionOptions,
  deps: OpticalMonitoringDeps,
  queueName = 'monitoring', // selaras dengan QUEUE_MONITORING di workers/queues.ts
): Worker<OpticalJobData> {
  const worker = new Worker<OpticalJobData>(
    queueName,
    async (job: Job<OpticalJobData>) => {
      const data = job.data;
      logger.log(`Job ${job.id} (${data.kind}) dimulai.`);
      if (data.kind === 'optical-poll') {
        await handleOpticalPoll(deps);
        return { ok: true };
      }
      if (data.kind === 'discover-unconfigured') {
        const found = await handleDiscoverUnconfigured(deps, data.oltId);
        return { ok: true, found };
      }
      logger.warn(`Job kind tidak dikenal: ${(data as { kind: string }).kind}`);
      return { ok: false, reason: 'unknown-kind' };
    },
    { connection, concurrency: 1 },
  );

  worker.on('completed', (job) => logger.log(`Job ${job.id} selesai.`));
  worker.on('failed', (job, err) =>
    logger.error(`Job ${job?.id} gagal: ${err.message}`),
  );
  return worker;
}
