/**
 * workers/invoice-generation.worker.ts
 * Worker untuk queue 'billing': generate invoice bulanan dan penerapan denda.
 *
 * Factory function — parent agent yang mem-bootstrap worker menyediakan
 * koneksi Redis (ioredis) dan dependensi. attempts/backoff dipasang saat job
 * ditambahkan (lihat addRepeatableJobs di queues.ts).
 */
import { Logger } from '@nestjs/common';
import type { RedisOptions } from 'ioredis';
import { Worker, Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { BillingAutomationService } from '../services/billing-automation.service';
import { QUEUE_BILLING } from './queues';

const logger = new Logger('InvoiceWorker');

export function createInvoiceWorker(
  connection: RedisOptions,
  deps: { billing: BillingAutomationService; prisma: PrismaService },
): Worker {
  const worker = new Worker(
    QUEUE_BILLING,
    async (job: Job) => {
      const d = job.data as { kind?: string; year?: number; month?: number };
      try {
        switch (d.kind) {
          case 'generate-monthly': {
            const now = new Date();
            // month opsional 1-12 (default bulan berjalan); target = tgl 1.
            const target = new Date(
              d.year ?? now.getFullYear(),
              (d.month ?? now.getMonth() + 1) - 1,
              1,
            );
            logger.log(
              `generate-monthly mulai untuk ${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`,
            );
            return await deps.billing.generateMonthlyInvoices(target);
          }
          case 'apply-penalties':
            logger.log('apply-penalties mulai');
            return await deps.billing.applyPenalties();
          default:
            throw new Error(`Unknown billing job kind: ${d.kind}`);
        }
      } catch (err) {
        logger.error(`Job ${String(job.id)} (${d?.kind}) gagal: ${String(err)}`);
        await deps.prisma.auditLog
          .create({
            data: {
              action: 'worker.job_failed',
              entity: 'job',
              entityId: String(job.id),
              diff: {
                queue: QUEUE_BILLING,
                kind: d?.kind,
                error: String(err),
              },
            },
          })
          .catch(() => {
            /* audit best-effort */
          });
        throw err;
      }
    },
    { connection, concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    logger.error(`Worker billing job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
