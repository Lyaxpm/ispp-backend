/**
 * workers/queues.ts
 * Definisi nama queue BullMQ + pendaftaran queue + jadwal repeatable jobs.
 *
 * Catatan: Worker dibuat tanpa defaultJobOptions (BullMQ Worker tidak
 * mendukungnya), sehingga attempts/backoff/removeOnComplete selalu dipasang
 * pada saat job ditambahkan — lihat addRepeatableJobs dan situs-situs enqueue
 * (mis. pengingat invoice di BillingAutomationService).
 */
import { BullModule } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export const QUEUE_BILLING = 'billing';
export const QUEUE_NETWORK_OPS = 'network-ops';
export const QUEUE_NOTIFICATIONS = 'notifications';
export const QUEUE_MONITORING = 'monitoring';

/** Daftarkan ke imports AppModule (atau modul root lain milik parent agent). */
export function registerAllQueues() {
  return [
    BullModule.registerQueue({ name: QUEUE_BILLING }),
    BullModule.registerQueue({ name: QUEUE_NETWORK_OPS }),
    BullModule.registerQueue({ name: QUEUE_NOTIFICATIONS }),
    BullModule.registerQueue({ name: QUEUE_MONITORING }),
  ];
}

export interface RepeatableQueueDeps {
  billing: Queue;
  networkOps: Queue;
  monitoring: Queue;
}

/**
 * Jadwalkan job berulang (idempoten via jobId tetap — pemanggilan ulang
 * tidak membuat duplikat):
 * - generate-monthly : tiap tanggal 1 pukul 00:30 → invoice bulanan
 * - apply-penalties   : tiap hari pukul 01:00 → denda keterlambatan
 * - evaluate-overdue  : tiap hari pukul 02:00 → isolasi/throttle tunggakan
 * - optical-poll      : tiap 15 menit → polling optik ONU (agen monitoring)
 */
export async function addRepeatableJobs(queues: RepeatableQueueDeps): Promise<void> {
  const base = {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  };

  await queues.billing.add(
    'generate-monthly',
    { kind: 'generate-monthly' },
    { ...base, repeat: { pattern: '30 0 1 * *' }, jobId: 'billing-generate-monthly' },
  );
  await queues.billing.add(
    'apply-penalties',
    { kind: 'apply-penalties' },
    { ...base, repeat: { pattern: '0 1 * * *' }, jobId: 'billing-apply-penalties' },
  );
  await queues.networkOps.add(
    'evaluate-overdue',
    { kind: 'evaluate-overdue' },
    { ...base, repeat: { pattern: '0 2 * * *' }, jobId: 'netops-evaluate-overdue' },
  );
  await queues.monitoring.add(
    'optical-poll',
    { kind: 'optical-poll' },
    { ...base, repeat: { every: 900000 }, jobId: 'monitoring-optical-poll' },
  );
}
