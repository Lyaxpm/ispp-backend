/**
 * workers/isolation.worker.ts
 * Worker untuk queue 'network-ops': operasi jaringan manual maupun otomatis
 * (isolasi, un-isolasi, throttle, evaluasi tunggakan).
 *
 * Factory function — parent agent yang mem-bootstrap worker bertanggung jawab
 * menyediakan koneksi Redis (ioredis) dan dependensi di bawah.
 * attempts/backoff dipasang saat job ditambahkan, bukan di Worker.
 */
import { Logger } from '@nestjs/common';
import type { RedisOptions } from 'ioredis';
import { Worker, Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { BillingAutomationService } from '../services/billing-automation.service';
import { NetworkOrchestratorService } from '../network/services/network-orchestrator.service';
import { RadiusSyncService } from '../modules/radius/radius-sync.service';
import { NotificationPort } from '../modules/notifications/ports/notification.port';
import { QUEUE_NETWORK_OPS } from './queues';

export interface IsolationWorkerDeps {
  billing: BillingAutomationService;
  orchestrator: NetworkOrchestratorService;
  radiusSync: RadiusSyncService;
  whatsapp: NotificationPort;
  prisma: PrismaService;
}

const logger = new Logger('IsolationWorker');

/**
 * Job data boleh membawa customerId sebagai string maupun number
 * (mis. dari API eksternal); selalu normalisasi ke integer positif.
 */
function toCustomerId(raw: string | number | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`customerId tidak valid pada job: ${String(raw)}`);
  }
  return id;
}

export function createIsolationWorker(
  connection: RedisOptions,
  deps: IsolationWorkerDeps,
): Worker {
  const worker = new Worker(
    QUEUE_NETWORK_OPS,
    async (job: Job) => {
      const d = job.data as {
        kind?: string;
        customerId?: string | number;
        reason?: string;
        downKbps?: number;
        upKbps?: number;
      };
      try {
        switch (d.kind) {
          case 'isolate': {
            const customerId = toCustomerId(d.customerId);
            await deps.orchestrator.isolateCustomer(
              customerId,
              d.reason ?? 'manual',
            );
            logger.log(`isolate OK: ${customerId} (${d.reason ?? 'manual'})`);
            break;
          }

          case 'unisolate': {
            const customerId = toCustomerId(d.customerId);
            await deps.orchestrator.unisolateCustomer(customerId);
            await deps.radiusSync
              .syncCustomer(customerId)
              .catch((e: unknown) =>
                logger.warn(
                  `radius sync gagal setelah unisolate ${customerId}: ${String(e)}`,
                ),
              );
            logger.log(`unisolate OK: ${customerId}`);
            break;
          }

          case 'throttle': {
            const customerId = toCustomerId(d.customerId);
            await deps.orchestrator.throttleCustomer(
              customerId,
              Number(d.downKbps ?? 512),
              Number(d.upKbps ?? 512),
            );
            logger.log(
              `throttle OK: ${d.customerId} (${d.downKbps ?? 512}/${d.upKbps ?? 512} kbps)`,
            );
            break;
          }

          case 'evaluate-overdue':
            return await deps.billing.evaluateOverdueAndIsolate();

          default:
            throw new Error(`Unknown network-ops job kind: ${d.kind}`);
        }
      } catch (err) {
        logger.error(
          `Job ${String(job.id)} (${d?.kind}) gagal: ${String(err)}`,
        );
        await deps.prisma.auditLog
          .create({
            data: {
              action: 'worker.job_failed',
              entity: 'job',
              entityId: String(job.id),
              diff: {
                queue: QUEUE_NETWORK_OPS,
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
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    logger.error(`Worker network-ops job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
