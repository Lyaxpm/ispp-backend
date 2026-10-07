import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { NodeStatus, OdpPortStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  NOTIFICATION_PORT,
  NotificationPort,
} from '../modules/notifications/ports/notification.port';

/**
 * Service inti geospasial + FTTH.
 *
 * Mengandalkan skema Prisma nyata (prisma/schema.prisma):
 * - Kolom `geom` PostGIS sudah ada di Olt/Odc/Odp/Customer (Point,4326) dan
 *   `routeGeom` di FiberCable (LineString,4326). Query spasial tetap dibungkus
 *   try/catch dengan fallback haversine bila ekstensi/kolom belum siap.
 * - Enum: NodeStatus, OdpPortStatus, CoreStatus, CableType (dari @prisma/client).
 * - AuditLog { action, entity, entityId, diff?, actorId? }.
 * - NotificationPort adalah abstract class dengan token NOTIFICATION_PORT;
 *   injeksi @Optional() agar service tetap jalan bila modul notifikasi belum
 *   terdaftar (fallback: log saja).
 */

export interface NearestOdpResult {
  id: number;
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  distM: number;
  freePorts: number;
}

export interface CoverageResult {
  covered: boolean;
  nearestOdp: NearestOdpResult | null;
  distM: number | null;
  message: string;
}

export interface OutageImpactCustomer {
  id: number;
  customerNo: string;
  name: string;
  phone: string | null;
  status: string;
  odpCode: string | null;
}

export interface OutageImpact {
  nodeType: 'OLT' | 'PON_PORT' | 'ODC' | 'ODP';
  nodeId: number;
  nodeLabel: string;
  affectedOdpCount: number;
  totalCustomers: number;
  affectedCustomers: OutageImpactCustomer[];
  estimatedAt: Date;
}

export type GeoJsonLayer = 'olt' | 'odc' | 'odp' | 'customer' | 'cable';

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry:
      | { type: 'Point'; coordinates: [number, number] }
      | { type: 'LineString'; coordinates: Array<[number, number]> };
    properties: Record<string, unknown>;
  }>;
  meta: { layer: string; total: number; skippedNoCoords: number };
}

const OUTAGE_ALERT_THROTTLE_MIN = 30;

@Injectable()
export class GisFtthService {
  private readonly logger = new Logger(GisFtthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(NOTIFICATION_PORT)
    private readonly notifications: NotificationPort | null,
  ) {}

  // ------------------------------------------------------------------ utils

  private validateLatLng(lat: number, lng: number): void {
    if (
      typeof lat !== 'number' ||
      typeof lng !== 'number' ||
      Number.isNaN(lat) ||
      Number.isNaN(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      throw new BadRequestException(
        'Koordinat tidak valid: lat harus -90..90 dan lng harus -180..180.',
      );
    }
  }

  /** Fallback jarak bila query PostGIS gagal. */
  private haversine(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371000; // meter
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  private async audit(
    action: string,
    entity: string,
    entityId: string,
    diff?: Record<string, unknown>,
    actorId?: number,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          entity,
          entityId,
          diff: (diff ?? {}) as Prisma.InputJsonValue,
          actorId,
        },
      });
    } catch (err) {
      // Best-effort: audit tidak boleh menggagalkan alur bisnis.
      this.logger.warn(`Gagal menulis audit log: ${(err as Error).message}`);
    }
  }

  private async getSetting(key: string): Promise<string | null> {
    const row = await this.prisma.setting
      .findUnique({ where: { key } })
      .catch(() => null);
    return row ? row.value : null;
  }

  private async setSetting(key: string, value: string): Promise<void> {
    await this.prisma.setting
      .upsert({ where: { key }, update: { value }, create: { key, value } })
      .catch((err) =>
        this.logger.warn(`Gagal menyimpan setting ${key}: ${(err as Error).message}`),
      );
  }

  // ------------------------------------------------------- nearest ODP (GIS)

  /**
   * Cari ODP ACTIVE terdekat dari titik kandidat.
   * Jalur utama: PostGIS (ST_DWithin + ST_Distance di atas geography).
   * Fallback: haversine di JS bila query spasial gagal.
   */
  async findNearestOdp(
    lat: number,
    lng: number,
    maxDistanceM = 500,
    limit = 5,
  ): Promise<NearestOdpResult[]> {
    this.validateLatLng(lat, lng);
    if (maxDistanceM <= 0 || maxDistanceM > 100000) {
      throw new BadRequestException('radius harus 1..100000 meter.');
    }
    const take = Math.min(Math.max(limit, 1), 20);

    try {
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: number;
          code: string;
          name: string;
          latitude: number | null;
          longitude: number | null;
          dist_m: number;
          free_ports: number;
        }>
      >`
        SELECT
          o.id,
          o.code,
          o.name,
          o.latitude,
          o.longitude,
          ST_Distance(
            o.geom::geography,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
          ) AS dist_m,
          (o.capacity - o."usedPorts") AS free_ports
        FROM "Odp" o
        WHERE o.status = 'ACTIVE'
          AND ST_DWithin(
            o.geom::geography,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
            ${maxDistanceM}
          )
        ORDER BY dist_m ASC
        LIMIT ${take}
      `;
      return rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        latitude: r.latitude,
        longitude: r.longitude,
        distM: Math.round(Number(r.dist_m) * 10) / 10,
        freePorts: Math.max(0, Number(r.free_ports)),
      }));
    } catch (err) {
      this.logger.warn(
        `PostGIS nearest-odp gagal, fallback ke haversine: ${(err as Error).message}`,
      );
      const odps = await this.prisma.odp.findMany({
        where: { status: NodeStatus.ACTIVE },
        select: {
          id: true,
          code: true,
          name: true,
          latitude: true,
          longitude: true,
          capacity: true,
          usedPorts: true,
        },
      });
      return odps
        .filter((o) => o.latitude != null && o.longitude != null)
        .map((o) => ({
          id: o.id,
          code: o.code,
          name: o.name,
          latitude: o.latitude,
          longitude: o.longitude,
          distM:
            Math.round(
              this.haversine(lat, lng, o.latitude as number, o.longitude as number) * 10,
            ) / 10,
          freePorts: Math.max(0, o.capacity - o.usedPorts),
        }))
        .filter((o) => o.distM <= maxDistanceM)
        .sort((a, b) => a.distM - b.distM)
        .slice(0, take);
    }
  }

  /** Cek cakupan layanan untuk titik koordinat (self-coverage check). */
  async checkCoverage(lat: number, lng: number): Promise<CoverageResult> {
    this.validateLatLng(lat, lng);
    const nearest = await this.findNearestOdp(lat, lng, 500, 1);
    const best = nearest[0] ?? null;
    if (!best) {
      return {
        covered: false,
        nearestOdp: null,
        distM: null,
        message:
          'Belum tercover: tidak ada ODP aktif dalam radius 500 m dari titik ini.',
      };
    }
    if (best.freePorts <= 0) {
      return {
        covered: false,
        nearestOdp: best,
        distM: best.distM,
        message: `ODP terdekat ${best.code} (${best.distM} m) sudah penuh (0 port tersedia).`,
      };
    }
    return {
      covered: true,
      nearestOdp: best,
      distM: best.distM,
      message: `Tercover! ODP ${best.code} berjarak ${best.distM} m dengan ${best.freePorts} port tersedia.`,
    };
  }

  // ------------------------------------------------- ODP port assignment

  /**
   * Pasangkan pelanggan ke port ODP pertama yang FREE.
   * Transaksional dengan row-level lock agar tidak ada double-booking port.
   */
  async assignCustomerToOdpPort(
    customerId: number,
    odpId: number,
    actorId?: number,
  ): Promise<{ odpPortId: number; portNo: number; odpCode: string }> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, customerNo: true, odpPortId: true },
    });
    if (!customer) {
      throw new NotFoundException(`Pelanggan id=${customerId} tidak ditemukan.`);
    }
    if (customer.odpPortId) {
      throw new ConflictException(
        `Pelanggan ${customer.customerNo} sudah terhubung ke port ODP (id=${customer.odpPortId}). Lepaskan dulu sebelum assign ulang.`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const odpRows = await tx.$queryRaw<
        Array<{ id: number; code: string; capacity: number; usedPorts: number }>
      >`SELECT id, code, capacity, "usedPorts" FROM "Odp" WHERE id = ${odpId} FOR UPDATE`;
      const odp = odpRows[0];
      if (!odp) throw new NotFoundException(`ODP id=${odpId} tidak ditemukan.`);
      if (odp.usedPorts >= odp.capacity) {
        throw new ConflictException(
          `ODP ${odp.code} penuh (${odp.usedPorts}/${odp.capacity} port terpakai).`,
        );
      }

      const portRows = await tx.$queryRaw<Array<{ id: number; portNo: number }>>`
        SELECT id, "portNo" FROM "OdpPort"
        WHERE "odpId" = ${odpId} AND status = 'FREE'
        ORDER BY "portNo" ASC
        LIMIT 1
        FOR UPDATE`;
      const port = portRows[0];
      if (!port) {
        throw new ConflictException(
          `ODP ${odp.code} tidak punya port FREE (kapasitas tercatat ${odp.capacity}, terpakai ${odp.usedPorts}).`,
        );
      }

      await tx.odpPort.update({
        where: { id: port.id },
        data: { status: OdpPortStatus.USED, customerId },
      });
      await tx.odp.update({
        where: { id: odpId },
        data: { usedPorts: { increment: 1 } },
      });
      await tx.customer.update({
        where: { id: customerId },
        data: { odpPortId: port.id },
      });
      return { odpPortId: port.id, portNo: port.portNo, odpCode: odp.code };
    });

    await this.audit(
      'ODP_PORT_ASSIGN',
      'Customer',
      String(customerId),
      { odpId, ...result },
      actorId,
    );
    return result;
  }

  /** Lepaskan port ODP milik pelanggan (reverse dari assign). */
  async releaseOdpPort(
    customerId: number,
    actorId?: number,
  ): Promise<{ releasedPortId: number }> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, customerNo: true, odpPortId: true },
    });
    if (!customer) {
      throw new NotFoundException(`Pelanggan id=${customerId} tidak ditemukan.`);
    }
    if (!customer.odpPortId) {
      throw new ConflictException(
        `Pelanggan ${customer.customerNo} tidak terhubung ke port ODP manapun.`,
      );
    }

    const releasedPortId = await this.prisma.$transaction(async (tx) => {
      const port = await tx.odpPort.findUnique({
        where: { id: customer.odpPortId as number },
        select: { id: true, odpId: true, status: true },
      });
      if (!port) {
        throw new NotFoundException(`OdpPort id=${customer.odpPortId} tidak ditemukan.`);
      }
      await tx.odpPort.update({
        where: { id: port.id },
        data: { status: OdpPortStatus.FREE, customerId: null },
      });
      // Guard agar usedPorts tidak negatif bila data tidak konsisten.
      const odp = await tx.odp.findUnique({
        where: { id: port.odpId },
        select: { usedPorts: true },
      });
      await tx.odp.update({
        where: { id: port.odpId },
        data: { usedPorts: Math.max(0, (odp?.usedPorts ?? 1) - 1) },
      });
      await tx.customer.update({
        where: { id: customerId },
        data: { odpPortId: null },
      });
      return port.id;
    });

    await this.audit(
      'ODP_PORT_RELEASE',
      'Customer',
      String(customerId),
      { releasedPortId },
      actorId,
    );
    return { releasedPortId };
  }

  // ------------------------------------------------- outage impact engine

  private async resolveAffectedOdpIds(
    nodeType: 'OLT' | 'PON_PORT' | 'ODC' | 'ODP',
    nodeId: number,
  ): Promise<{ odpIds: number[]; nodeLabel: string }> {
    switch (nodeType) {
      case 'ODP': {
        const odp = await this.prisma.odp.findUnique({
          where: { id: nodeId },
          select: { id: true, code: true, name: true },
        });
        if (!odp) throw new NotFoundException(`ODP id=${nodeId} tidak ditemukan.`);
        return { odpIds: [odp.id], nodeLabel: `${odp.code} (${odp.name})` };
      }
      case 'ODC': {
        const odc = await this.prisma.odc.findUnique({
          where: { id: nodeId },
          select: { id: true, code: true, name: true },
        });
        if (!odc) throw new NotFoundException(`ODC id=${nodeId} tidak ditemukan.`);
        const odps = await this.prisma.odc
          .findUnique({ where: { id: odc.id } })
          .odps({ select: { id: true } });
        return {
          odpIds: (odps ?? []).map((o) => o.id),
          nodeLabel: `${odc.code} (${odc.name})`,
        };
      }
      case 'PON_PORT': {
        const pon = await this.prisma.ponPort.findUnique({
          where: { id: nodeId },
          select: { id: true, name: true, olt: { select: { name: true } } },
        });
        if (!pon) throw new NotFoundException(`PON Port id=${nodeId} tidak ditemukan.`);
        const odcs = await this.prisma.odc.findMany({
          where: { ponPortId: pon.id },
          select: { id: true },
        });
        const odps = await this.prisma.odp.findMany({
          where: {
            OR: [{ ponPortId: pon.id }, { odcId: { in: odcs.map((o) => o.id) } }],
          },
          select: { id: true },
        });
        return {
          odpIds: odps.map((o) => o.id),
          nodeLabel: `PON ${pon.name} @ ${pon.olt?.name ?? 'OLT?'}`,
        };
      }
      case 'OLT': {
        const olt = await this.prisma.olt.findUnique({
          where: { id: nodeId },
          select: { id: true, name: true },
        });
        if (!olt) throw new NotFoundException(`OLT id=${nodeId} tidak ditemukan.`);
        const ponPorts = await this.prisma.ponPort.findMany({
          where: { oltId: olt.id },
          select: { id: true },
        });
        const ponIds = ponPorts.map((p) => p.id);
        const odcs = await this.prisma.odc.findMany({
          where: { ponPortId: { in: ponIds } },
          select: { id: true },
        });
        const odps = await this.prisma.odp.findMany({
          where: {
            OR: [{ ponPortId: { in: ponIds } }, { odcId: { in: odcs.map((o) => o.id) } }],
          },
          select: { id: true },
        });
        return { odpIds: odps.map((o) => o.id), nodeLabel: `OLT ${olt.name}` };
      }
    }
  }

  /**
   * Hitung dampak gangguan: pelanggan mana saja yang terdampak bila sebuah
   * node (OLT / PON Port / ODC / ODP) down, berdasarkan hierarki FTTH.
   */
  async calculateOutageImpact(
    nodeType: 'OLT' | 'PON_PORT' | 'ODC' | 'ODP',
    nodeId: number,
  ): Promise<OutageImpact> {
    const { odpIds, nodeLabel } = await this.resolveAffectedOdpIds(nodeType, nodeId);

    let affectedCustomers: OutageImpactCustomer[] = [];
    if (odpIds.length > 0) {
      const rows = await this.prisma.customer.findMany({
        where: { odpPort: { odpId: { in: odpIds } } },
        select: {
          id: true,
          customerNo: true,
          name: true,
          phone: true,
          status: true,
          odpPort: { select: { odp: { select: { code: true } } } },
        },
      });
      affectedCustomers = rows.map((c) => ({
        id: c.id,
        customerNo: c.customerNo,
        name: c.name,
        phone: c.phone,
        status: c.status,
        odpCode: c.odpPort?.odp?.code ?? null,
      }));
    }

    return {
      nodeType,
      nodeId,
      nodeLabel,
      affectedOdpCount: odpIds.length,
      totalCustomers: affectedCustomers.length,
      affectedCustomers,
      estimatedAt: new Date(),
    };
  }

  /**
   * Kirim notifikasi WhatsApp massal untuk impact gangguan.
   * Throttle: maksimal 1x per 30 menit per node (via Setting).
   */
  async notifyOutageImpact(
    impact: OutageImpact,
  ): Promise<{ notified: number; skippedThrottle: boolean }> {
    const throttleKey = `LAST_OUTAGE_ALERT_${impact.nodeType}_${impact.nodeId}`;
    const last = await this.getSetting(throttleKey);
    if (last) {
      const elapsedMin = (Date.now() - new Date(last).getTime()) / 60000;
      if (elapsedMin < OUTAGE_ALERT_THROTTLE_MIN) {
        this.logger.log(
          `Notifikasi outage ${impact.nodeLabel} di-skip (throttle ${elapsedMin.toFixed(1)} mnt < ${OUTAGE_ALERT_THROTTLE_MIN}).`,
        );
        return { notified: 0, skippedThrottle: true };
      }
    }

    const phones = Array.from(
      new Set(
        impact.affectedCustomers
          .map((c) => (c.phone ?? '').trim())
          .filter((p) => p.length >= 9),
      ),
    );

    const message =
      `🚨 *GANGGUAN MASSAL TERDETEKSI*\n\n` +
      `Node: ${impact.nodeLabel} (${impact.nodeType})\n` +
      `ODP terdampak: ${impact.affectedOdpCount}\n` +
      `Estimasi pelanggan terdampak: ${impact.totalCustomers}\n\n` +
      `Tim NOC kami sedang menangani gangguan ini. ` +
      `Mohon maaf atas ketidaknyamanannya. Kami akan mengabari setelah layanan pulih.\n\n` +
      `Terima kasih.`;

    let notified = 0;
    if (phones.length > 0) {
      if (!this.notifications) {
        this.logger.warn(
          `Modul notifikasi belum tersedia; alert outage TIDAK terkirim ke ${phones.length} nomor.`,
        );
      } else {
        try {
          await this.notifications.sendOutageAlert(phones, message);
          notified = phones.length;
        } catch (err) {
          this.logger.error(`Gagal mengirim alert outage: ${(err as Error).message}`);
        }
      }
    } else {
      this.logger.log(
        `Outage ${impact.nodeLabel}: tidak ada nomor pelanggan valid untuk dinotifikasi.`,
      );
    }

    await this.setSetting(throttleKey, new Date().toISOString());
    await this.audit('OUTAGE_IMPACT_ALERT', impact.nodeType, String(impact.nodeId), {
      nodeLabel: impact.nodeLabel,
      affectedOdpCount: impact.affectedOdpCount,
      totalCustomers: impact.totalCustomers,
      notified,
    });
    return { notified, skippedThrottle: false };
  }

  // ------------------------------------------------------- topology & export

  /** Pohon topologi FTTH: OLT -> PON Port -> (ODC -> ODP | ODP langsung) -> Port -> Customer. */
  async getTopologyTree(oltId: number) {
    const portInclude = {
      orderBy: { portNo: 'asc' },
      include: {
        customer: {
          select: { customerNo: true, name: true, status: true },
        },
      },
    } as const;
    const olt = await this.prisma.olt.findUnique({
      where: { id: oltId },
      include: {
        ponPorts: {
          orderBy: [{ slotNo: 'asc' }, { ponNo: 'asc' }],
          include: {
            // ODP yang digantung langsung ke PON port
            odps: {
              orderBy: { code: 'asc' },
              include: { ports: portInclude },
            },
            // ODC di PON port ini beserta ODP-ODP di bawahnya
            odcs: {
              orderBy: { code: 'asc' },
              include: {
                odps: {
                  orderBy: { code: 'asc' },
                  include: { ports: portInclude },
                },
              },
            },
          },
        },
      },
    });
    if (!olt) throw new NotFoundException(`OLT id=${oltId} tidak ditemukan.`);
    return olt;
  }

  /**
   * Export GeoJSON per layer untuk Leaflet/Mapbox.
   * Layer kabel memakai routeGeom (LineString) via ST_AsGeoJSON; layer lain
   * memakai kolom latitude/longitude.
   */
  async exportGeoJSON(layer: GeoJsonLayer): Promise<GeoJsonFeatureCollection> {
    const fc: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [],
      meta: { layer, total: 0, skippedNoCoords: 0 },
    };
    const pushPoint = (
      lat: number | null | undefined,
      lng: number | null | undefined,
      properties: Record<string, unknown>,
    ) => {
      if (lat == null || lng == null) {
        fc.meta.skippedNoCoords += 1;
        return;
      }
      fc.features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties,
      });
      fc.meta.total += 1;
    };

    switch (layer) {
      case 'olt': {
        const rows = await this.prisma.olt.findMany({
          select: {
            id: true, name: true, vendor: true, model: true,
            popLocation: true, status: true, latitude: true, longitude: true,
          },
        });
        for (const r of rows) {
          pushPoint(r.latitude, r.longitude, {
            id: r.id, name: r.name, vendor: r.vendor, model: r.model,
            popLocation: r.popLocation, status: r.status,
          });
        }
        break;
      }
      case 'odc': {
        const rows = await this.prisma.odc.findMany({
          select: {
            id: true, code: true, name: true, capacity: true,
            status: true, latitude: true, longitude: true,
          },
        });
        for (const r of rows) {
          pushPoint(r.latitude, r.longitude, {
            id: r.id, code: r.code, name: r.name,
            capacity: r.capacity, status: r.status,
          });
        }
        break;
      }
      case 'odp': {
        const rows = await this.prisma.odp.findMany({
          select: {
            id: true, code: true, name: true, capacity: true,
            usedPorts: true, status: true, latitude: true, longitude: true,
          },
        });
        for (const r of rows) {
          pushPoint(r.latitude, r.longitude, {
            id: r.id, code: r.code, name: r.name,
            capacity: r.capacity, usedPorts: r.usedPorts,
            freePorts: Math.max(0, r.capacity - r.usedPorts),
            status: r.status,
          });
        }
        break;
      }
      case 'customer': {
        const rows = await this.prisma.customer.findMany({
          select: {
            id: true, customerNo: true, name: true, phone: true,
            status: true, latitude: true, longitude: true,
          },
        });
        for (const r of rows) {
          pushPoint(r.latitude, r.longitude, {
            id: r.id, customerNo: r.customerNo, name: r.name,
            phone: r.phone, status: r.status,
          });
        }
        break;
      }
      case 'cable': {
        try {
          const rows = await this.prisma.$queryRaw<
            Array<{
              id: number;
              code: string;
              name: string;
              cableType: string;
              coreCount: number;
              lengthM: number | null;
              status: string;
              route_geojson: string | null;
            }>
          >`
            SELECT id, code, name, "cableType", "coreCount", "lengthM", status,
                   ST_AsGeoJSON("routeGeom") AS route_geojson
            FROM "FiberCable"`;
          for (const r of rows) {
            if (!r.route_geojson) {
              fc.meta.skippedNoCoords += 1;
              continue;
            }
            const geom = JSON.parse(r.route_geojson) as {
              type: string;
              coordinates: Array<[number, number]>;
            };
            if (geom.type !== 'LineString' || !Array.isArray(geom.coordinates)) {
              fc.meta.skippedNoCoords += 1;
              continue;
            }
            fc.features.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: geom.coordinates },
              properties: {
                id: Number(r.id), code: r.code, name: r.name,
                cableType: r.cableType, coreCount: Number(r.coreCount),
                lengthM: r.lengthM, status: r.status,
              },
            });
            fc.meta.total += 1;
          }
        } catch (err) {
          this.logger.warn(`Export GeoJSON kabel gagal: ${(err as Error).message}`);
          throw new BadRequestException(
            'Gagal membaca rute kabel (pastikan kolom routeGeom & ekstensi PostGIS tersedia).',
          );
        }
        break;
      }
      default:
        throw new BadRequestException(
          `Layer tidak dikenal: ${layer}. Pilih olt|odc|odp|customer|cable.`,
        );
    }
    return fc;
  }
}
