import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, Worker } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { BillingAutomationService } from '../services/billing-automation.service';
import { GisFtthService } from '../services/gis-ftth.service';
import { DriverFactory } from '../network/drivers/driver-factory';
import { NetworkOrchestratorService } from '../network/services/network-orchestrator.service';
import { RadiusSyncService } from '../modules/radius/radius-sync.service';
import { TelegramService } from '../modules/notifications/telegram.service';
import {
  NOTIFICATION_PORT,
  NotificationPort,
} from '../modules/notifications/ports/notification.port';
import { NetworkModule } from '../network/network.module';
import { RadiusModule } from '../modules/radius/radius.module';
import { GisModule } from '../modules/gis/gis.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import {
  QUEUE_BILLING,
  QUEUE_MONITORING,
  QUEUE_NETWORK_OPS,
  QUEUE_NOTIFICATIONS,
  addRepeatableJobs,
} from './queues';
import { createIsolationWorker } from './isolation.worker';
import { createInvoiceWorker } from './invoice-generation.worker';
import { createOpticalMonitoringWorker } from './optical-monitoring.worker';

/**
 * Mengurai REDIS_URL (mis. redis://:pass@host:6379/0 atau rediss://...)
 * menjadi RedisOptions yang diterima BullMQ (butuh maxRetriesPerRequest:
 * null + enableReadyCheck: false).
 */
export function redisOptionsFromUrl(url: string): RedisOptions {
  const u = new URL(url);
  const opts: RedisOptions = {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 6379,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) || 0 : 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.protocol === 'rediss:') opts.tls = {};
  return opts;
}

/**
 * WorkersService — mem-bootstrap semua BullMQ worker + jadwal repeatable
 * saat aplikasi start, dan menutupnya dengan rapi saat shutdown.
 *
 * Dimatikan via env WORKERS_ENABLED=false bila worker dijalankan sebagai
 * proses terpisah (skala horizontal).
 */
@Injectable()
export class WorkersService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkersService.name);
  private workers: Worker[] = [];
  private queues: Queue[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly billing: BillingAutomationService,
    private readonly orchestrator: NetworkOrchestratorService,
    private readonly radiusSync: RadiusSyncService,
    private readonly factory: DriverFactory,
    private readonly gis: GisFtthService,
    private readonly telegram: TelegramService,
    @Inject(NOTIFICATION_PORT)
    private readonly notifications: NotificationPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('WORKERS_ENABLED', 'true') !== 'true') {
      this.logger.log('Workers dinonaktifkan (WORKERS_ENABLED=false)');
      return;
    }
    const connection = redisOptionsFromUrl(
      this.config.getOrThrow<string>('REDIS_URL'),
    );

    try {
      const billingQ = new Queue(QUEUE_BILLING, { connection });
      const networkOpsQ = new Queue(QUEUE_NETWORK_OPS, { connection });
      const monitoringQ = new Queue(QUEUE_MONITORING, { connection });
      const notificationsQ = new Queue(QUEUE_NOTIFICATIONS, { connection });
      this.queues.push(billingQ, networkOpsQ, monitoringQ, notificationsQ);

      // Jadwal berulang (idempoten via jobId tetap).
      await addRepeatableJobs({
        billing: billingQ,
        networkOps: networkOpsQ,
        monitoring: monitoringQ,
      });

      this.workers.push(
        createIsolationWorker(connection, {
          billing: this.billing,
          orchestrator: this.orchestrator,
          radiusSync: this.radiusSync,
          whatsapp: this.notifications,
          prisma: this.prisma,
        }),
        createInvoiceWorker(connection, {
          billing: this.billing,
          prisma: this.prisma,
        }),
        createOpticalMonitoringWorker(connection, {
          prisma: this.prisma,
          factory: this.factory,
          gis: this.gis,
          alerter: {
            sendNocAlarm: (message: string) =>
              this.telegram.sendAlarm('NOC Alarm', message),
          },
        }),
        this.createNotificationsWorker(connection),
      );
      this.logger.log(
        `4 worker aktif: ${QUEUE_BILLING}, ${QUEUE_NETWORK_OPS}, ${QUEUE_MONITORING}, ${QUEUE_NOTIFICATIONS}`,
      );
    } catch (err) {
      this.logger.error(
        `Gagal mem-bootstrap worker (Redis tidak terjangkau?): ${String(err)}`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      this.workers.map((w) =>
        w.close().catch((err: unknown) => {
          this.logger.warn(`Gagal menutup worker: ${String(err)}`);
        }),
      ),
    );
    await Promise.all(
      this.queues.map((q) =>
        q.close().catch(() => {
          /* abaikan */
        }),
      ),
    );
    this.workers = [];
    this.queues = [];
  }

  /**
   * Konsumen queue 'notifications': mengirim pengingat tagihan yang
   * diantrekan oleh BillingAutomationService.generateMonthlyInvoices().
   */
  private createNotificationsWorker(connection: RedisOptions): Worker {
    const worker = new Worker(
      QUEUE_NOTIFICATIONS,
      async (job: Job) => {
        const d = job.data as { kind?: string; invoiceId?: number | string };
        if (d.kind !== 'invoice-reminder') {
          throw new Error(`Unknown notifications job kind: ${d.kind}`);
        }
        const invoiceId = Number(d.invoiceId);
        if (!Number.isInteger(invoiceId)) {
          throw new Error(`invoiceId tidak valid: ${String(d.invoiceId)}`);
        }
        const invoice = await this.prisma.invoice.findUnique({
          where: { id: invoiceId },
          include: { customer: true },
        });
        if (!invoice || !invoice.customer) {
          this.logger.warn(
            `invoice-reminder: invoice ${invoiceId} tidak ditemukan, dilewati`,
          );
          return;
        }
        const c = invoice.customer;
        const message = this.notifications.tplInvoiceReminder(
          {
            id: String(c.id),
            customerNo: c.customerNo,
            name: c.name,
            phone: c.phone,
          },
          {
            id: String(invoice.id),
            number: invoice.number,
            total: Number(invoice.total),
            amountPaid: Number(invoice.amountPaid),
            dueDate: invoice.dueDate,
            periodStart: invoice.periodStart,
            periodEnd: invoice.periodEnd,
            status: invoice.status,
          },
        );
        await this.notifications.sendWhatsApp(c.phone, message);
        this.logger.log(`Pengingat WA terkirim untuk invoice ${invoice.number}`);
      },
      { connection },
    );
    worker.on('failed', (job, err) => {
      this.logger.error(
        `notifications job ${job?.id} gagal: ${err.message}`,
      );
    });
    return worker;
  }
}

@Module({
  imports: [NetworkModule, RadiusModule, GisModule, NotificationsModule],
  providers: [WorkersService],
})
export class WorkersModule {}
