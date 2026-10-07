/**
 * billing-automation.service.ts
 * Otak otomasi billing: invoice bulanan, webhook pembayaran (Midtrans/Xendit),
 * penyelesaian pembayaran, denda, evaluasi tunggakan → isolasi/throttle,
 * serta pembayaran manual kasir.
 *
 * Invarian:
 * - Setiap pergerakan uang berjalan dalam Prisma $transaction.
 * - Idempotency webhook via status payment ('PAID' → skip) dan
 *   @@unique(customerId, periodStart, periodEnd) pada invoice
 *   (reference payment juga @unique).
 * - Kegagalan jaringan/notifikasi TIDAK PERNAH membatalkan pembayaran yang
 *   sudah settled (postSettlementActions bersifat best-effort).
 *
 * Kontrak silang (disediakan agen lain, diimpor di path persis):
 * - ../prisma/prisma.service (PrismaService)
 * - ../network/services/network-orchestrator.service (NetworkOrchestratorService)
 * - ../modules/radius/radius-sync.service (RadiusSyncService)
 * - ../modules/notifications/ports/notification.port (NOTIFICATION_PORT, NotificationPort)
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import {
  CustomerStatus,
  InvoiceStatus,
  OnuStatus,
  PaymentMethod,
  PaymentStatus,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NetworkOrchestratorService } from '../network/services/network-orchestrator.service';
import { RadiusSyncService } from '../modules/radius/radius-sync.service';
import {
  NOTIFICATION_PORT,
  NotificationPort,
  type CustomerRef,
  type InvoiceRef,
  type PaymentRef,
} from '../modules/notifications/ports/notification.port';
import {
  allocateInvoiceNumber,
  computeTotals,
  daysInMonth,
  formatRupiah,
  getSecret,
  getSetting,
  safeEqual,
  sanitizeReference,
} from '../common/utils/billing-math.util';
import { QUEUE_NOTIFICATIONS } from '../workers/queues';

/** Baris payment minimal yang dibutuhkan settlement & notifikasi. */
export interface PaymentRow {
  id: number;
  invoiceId: number | null;
  customerId: number;
  amount: unknown;
  status: PaymentStatus | string;
  reference?: string;
  method?: string;
  channel?: string | null;
  paidAt?: Date | null;
}

interface SettleInput {
  id: number;
  invoiceId: number;
  customerId: number;
  amount: number;
}

const DAY_MS = 86_400_000;

@Injectable()
export class BillingAutomationService {
  private readonly logger = new Logger(BillingAutomationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly networkOrchestrator: NetworkOrchestratorService,
    private readonly radiusSync: RadiusSyncService,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @InjectQueue(QUEUE_NOTIFICATIONS) private readonly notificationsQueue: Queue,
  ) {}

  /**
   * Audit best-effort ke AuditLog (schema: action, entity, entityId, diff,
   * actorId?, customerId?). Tidak pernah melempar.
   */
  private async audit(
    action: string,
    entity: string,
    entityId: number | string,
    metadata: Record<string, unknown>,
    actorId?: number,
    customerId?: number,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          entity,
          entityId: String(entityId),
          diff: metadata as Prisma.InputJsonValue,
          actorId: actorId ?? undefined,
          customerId: customerId ?? undefined,
        },
      });
    } catch (err) {
      this.logger.warn(`Audit gagal ditulis (${action}): ${String(err)}`);
    }
  }

  // ------------------------------------------------------------------ //
  // Webhook Midtrans
  // ------------------------------------------------------------------ //

  /**
   * Handler webhook Midtrans. Menerima rawBody agar signature HMAC-SHA512
   * diverifikasi terhadap byte mentah (bukan JSON yang sudah di-parse ulang).
   */
  async handleMidtransWebhook(
    rawBody: Buffer,
    signatureHeader: string,
  ): Promise<{ ok: boolean; message: string }> {
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      order_id: string;
      status_code: string;
      gross_amount: string;
      transaction_status: string;
      fraud_status?: string;
      payment_type?: string;
      transaction_id?: string;
    };
    const { order_id, status_code, gross_amount, transaction_status } = payload;

    const serverKey = await getSecret(this.prisma, 'MIDTRANS_SERVER_KEY');
    const expected = crypto
      .createHmac('sha512', serverKey)
      .update(String(order_id) + String(status_code) + String(gross_amount) + serverKey)
      .digest('hex');
    if (!safeEqual(signatureHeader ?? '', expected)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const payment = await this.prisma.payment.findUnique({
      where: { reference: order_id },
      include: { invoice: true, customer: true },
    });
    if (!payment) throw new NotFoundException(`Payment ${order_id} tidak ditemukan`);

    // Idempotency: payment yang sudah PAID tidak diproses ulang.
    if (payment.status === PaymentStatus.PAID) {
      return { ok: true, message: 'already processed' };
    }
    if (!payment.invoiceId) {
      throw new BadRequestException('Payment tidak terhubung ke invoice');
    }

    const grossAmount = Number(gross_amount);

    switch (transaction_status) {
      case 'capture':
      case 'settlement':
        if (payload.fraud_status === 'challenge') {
          await this.prisma.payment.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.PENDING, rawWebhook: payload as Prisma.InputJsonValue },
          });
          this.logger.log(`Midtrans ${order_id}: fraud challenge → PENDING`);
          return { ok: true, message: 'challenge pending review' };
        }
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { rawWebhook: payload as Prisma.InputJsonValue },
        });
        await this.settlePayment(
          {
            id: payment.id,
            invoiceId: payment.invoiceId as number,
            customerId: payment.customerId,
            amount: Number(payment.amount),
          },
          grossAmount,
        );
        return { ok: true, message: 'settled' };

      case 'pending':
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.PENDING, rawWebhook: payload as Prisma.InputJsonValue },
        });
        return { ok: true, message: 'pending' };

      case 'deny':
      case 'cancel':
      case 'expire':
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.FAILED, rawWebhook: payload as Prisma.InputJsonValue },
        });
        await this.audit('billing.payment_failed', 'Payment', payment.id, {
          orderId: order_id,
          transactionStatus: transaction_status,
          paymentType: payload.payment_type,
        });
        return { ok: true, message: 'marked failed' };

      default:
        this.logger.warn(`Midtrans ${order_id}: status tak dikenal '${transaction_status}'`);
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { rawWebhook: payload as Prisma.InputJsonValue },
        });
        return { ok: true, message: 'ignored' };
    }
  }

  // ------------------------------------------------------------------ //
  // Webhook Xendit
  // ------------------------------------------------------------------ //

  /**
   * Handler callback Xendit (invoice/payment). Keaslian diverifikasi via
   * x-callback-token yang dibandingkan waktu-konstan dengan env.
   */
  async handleXenditWebhook(
    payload: any,
    callbackToken: string,
  ): Promise<{ ok: boolean }> {
    if (!safeEqual(callbackToken ?? '', process.env.XENDIT_CALLBACK_TOKEN ?? '')) {
      throw new UnauthorizedException('Invalid Xendit callback token');
    }
    const externalId = String(payload?.external_id ?? '');
    const payment = await this.prisma.payment.findUnique({
      where: { reference: externalId },
      include: { invoice: true, customer: true },
    });
    if (!payment) throw new NotFoundException(`Payment ${externalId} tidak ditemukan`);

    // Idempotency
    if (payment.status === PaymentStatus.PAID) return { ok: true };
    if (!payment.invoiceId) {
      throw new BadRequestException('Payment tidak terhubung ke invoice');
    }

    const status = String(payload?.status ?? '').toUpperCase();
    if (status === 'PAID') {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { rawWebhook: payload as Prisma.InputJsonValue },
      });
      await this.settlePayment(
        {
          id: payment.id,
          invoiceId: payment.invoiceId as number,
          customerId: payment.customerId,
          amount: Number(payment.amount),
        },
        Number(payload.amount),
      );
      return { ok: true };
    }
    if (status === 'EXPIRED') {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.EXPIRED, rawWebhook: payload as Prisma.InputJsonValue },
      });
      await this.audit('billing.payment_expired', 'Payment', payment.id, { externalId });
      return { ok: true };
    }
    // PENDING / status lain: simpan payload mentah saja.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { rawWebhook: payload as Prisma.InputJsonValue },
    });
    return { ok: true };
  }

  // ------------------------------------------------------------------ //
  // Settlement
  // ------------------------------------------------------------------ //

  /**
   * Selesaikan satu payment: transisi status + alokasi ke invoice + overpay
   * ke balance pelanggan, semua dalam satu transaksi. Idempoten via
   * pemeriksaan ulang status di dalam transaksi.
   */
  async settlePayment(input: SettleInput, grossAmount: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const cur = await tx.payment.findUnique({ where: { id: input.id } });
      if (!cur || cur.status === PaymentStatus.PAID) return; // sudah diproses (idempotent)
      await this.applySettlementTx(tx, cur as PaymentRow, grossAmount);
    });

    const freshPayment = await this.prisma.payment.findUnique({
      where: { id: input.id },
    });
    if (!freshPayment || !freshPayment.invoiceId) return;
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: freshPayment.invoiceId },
    });
    const customer = await this.prisma.customer.findUnique({
      where: { id: freshPayment.customerId },
    });
    if (!invoice || !customer) return;

    await this.postSettlementActions(
      customer.id,
      toPaymentRef(freshPayment),
      toInvoiceRef(invoice),
    );
  }

  /**
   * Inti settlement — dipanggil dari dalam $transaction. Menandai payment
   * PAID, menambah amountPaid invoice (dengan cap total; kelebihan masuk ke
   * balance pelanggan), lalu menulis audit.
   */
  private async applySettlementTx(
    tx: Prisma.TransactionClient,
    payment: PaymentRow,
    amount: number,
  ): Promise<void> {
    if (!payment.invoiceId) {
      throw new BadRequestException('Payment tidak terhubung ke invoice');
    }
    const paidAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;

    await tx.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.PAID, paidAt: new Date() },
    });

    const invoice = await tx.invoice.findUnique({
      where: { id: payment.invoiceId },
    });
    if (!invoice) {
      throw new NotFoundException(`Invoice ${payment.invoiceId} tidak ditemukan`);
    }

    const total = Number(invoice.total);
    const newPaid = Number(invoice.amountPaid) + paidAmount;
    const overpay = Math.max(0, newPaid - total);
    const cappedPaid = newPaid - overpay;
    const invoiceStatus = cappedPaid >= total ? InvoiceStatus.PAID : InvoiceStatus.PARTIAL;

    await tx.invoice.update({
      where: { id: invoice.id },
      data: { amountPaid: cappedPaid, status: invoiceStatus },
    });

    if (overpay > 0) {
      await tx.customer.update({
        where: { id: invoice.customerId },
        data: { balance: { increment: overpay } },
      });
      this.logger.log(
        `Overpay ${formatRupiah(overpay)} dari payment ${payment.id} masuk ke balance pelanggan ${invoice.customerId}`,
      );
    }

    await this.audit(
      'billing.payment_settled',
      'Payment',
      payment.id,
      {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        amount: paidAmount,
        overpay,
        invoiceStatus,
      },
      undefined,
      invoice.customerId,
    );
  }

  /**
   * Aksi pasca-settlement (best-effort, di luar transaksi uang):
   * - Pelanggan ISOLATED → unisolate jaringan, sync RADIUS, status ACTIVE,
   *   ONU ONLINE, kirim WA aktivasi.
   * - Selalu kirim struk pembayaran via WhatsApp.
   * Kegagalan jaringan/notifikasi hanya di-log, tidak membatalkan settlement.
   */
  async postSettlementActions(
    customerId: number,
    payment: PaymentRef,
    invoice: InvoiceRef,
  ): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) {
      this.logger.warn(`postSettlementActions: pelanggan ${customerId} tidak ditemukan`);
      return;
    }
    const customerRef: CustomerRef = {
      id: String(customer.id),
      customerNo: customer.customerNo,
      name: customer.name,
      phone: customer.phone,
    };

    if (customer.status === CustomerStatus.ISOLATED) {
      try {
        await this.networkOrchestrator.unisolateCustomer(customerId);
        await this.radiusSync.syncCustomer(customerId);
        await this.prisma.customer.update({
          where: { id: customerId },
          data: { status: CustomerStatus.ACTIVE },
        });
        await this.prisma.onu
          .updateMany({ where: { customerId }, data: { status: OnuStatus.ONLINE } })
          .catch((err: unknown) =>
            this.logger.warn(`Gagal update status ONU pelanggan ${customerId}: ${String(err)}`),
          );
        const msg = this.notifications.tplActivationNotice(customerRef);
        await this.notifications.sendWhatsApp(customer.phone, msg);
        await this.audit(
          'billing.customer_reactivated',
          'Customer',
          customerId,
          { invoiceId: invoice.id, invoiceNumber: invoice.number },
          undefined,
          customerId,
        );
        this.logger.log(`Pelanggan ${customer.customerNo} diaktifkan kembali setelah pembayaran`);
      } catch (err) {
        // Jaringan/notifikasi gagal — pembayaran tetap settled.
        this.logger.error(
          `Gagal reaktivasi pelanggan ${customerId} setelah settlement: ${String(err)}`,
        );
      }
    }

    try {
      const receipt = this.notifications.tplPaymentReceipt(customerRef, payment, invoice);
      await this.notifications.sendWhatsApp(customer.phone, receipt);
    } catch (err) {
      this.logger.error(
        `Gagal kirim struk pembayaran ke ${customer.phone}: ${String(err)}`,
      );
    }
  }

  // ------------------------------------------------------------------ //
  // Invoice bulanan
  // ------------------------------------------------------------------ //

  /**
   * Generate invoice untuk semua langganan ACTIVE pada bulan target.
   * Idempoten per (customerId, periodStart, periodEnd) — invoice yang sudah
   * ada dilewati. Setiap invoice dibuat dalam transaksinya sendiri agar satu
   * kegagalan tidak menggagalkan batch.
   *
   * CATATAN: kolom periodStart/periodEnd bertipe @db.Date (tanpa jam), jadi
   * keduanya dinormalisasi ke 00:00:00.
   */
  async generateMonthlyInvoices(targetMonth: Date): Promise<{
    created: number;
    skipped: number;
    failed: number;
  }> {
    const year = targetMonth.getFullYear();
    const monthIndex = targetMonth.getMonth();
    const dim = daysInMonth(year, monthIndex);
    const periodStart = new Date(year, monthIndex, 1, 0, 0, 0, 0);
    const periodEnd = new Date(year, monthIndex, dim, 0, 0, 0, 0);
    const now = new Date();

    const ppnRate = Number(await getSetting(this.prisma, 'PPN_RATE', '11'));
    const adminFee = Number(await getSetting(this.prisma, 'ADMIN_FEE', '2500'));

    const subs = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE' },
      include: { customer: true, package: true },
    });

    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const sub of subs) {
      try {
        if (!sub.customer || sub.customer.status !== CustomerStatus.ACTIVE || !sub.package) {
          skipped++;
          continue;
        }

        // Idempotency: invoice periode ini sudah ada?
        const existing = await this.prisma.invoice.findFirst({
          where: {
            customerId: sub.customerId,
            periodStart,
            periodEnd,
          },
          select: { id: true },
        });
        if (existing) {
          skipped++;
          continue;
        }

        // Harga dasar + prorata bila langganan mulai/berakhir di tengah bulan.
        let price = Number(sub.priceOverride ?? sub.package.price);
        const subStart = new Date(sub.startDate);
        const subEnd = sub.endDate ? new Date(sub.endDate) : null;
        if (subStart > periodStart) {
          const usedDays = dim - subStart.getDate() + 1;
          price = Math.round((price * usedDays) / dim);
        } else if (subEnd && subEnd < periodEnd) {
          const usedDays = subEnd.getDate();
          price = Math.round((price * usedDays) / dim);
        }

        const totals = computeTotals({
          price,
          ppnRatePercent: Number.isFinite(ppnRate) ? ppnRate : 0,
          adminFee: Number.isFinite(adminFee) ? adminFee : 0,
        });

        const dueDay = Math.min(Number(sub.customer.dueDay) || 10, dim);
        const dueDate = new Date(year, monthIndex, dueDay, 23, 59, 59, 999);

        const invoice = await this.prisma.$transaction(async (tx) => {
          const number = await allocateInvoiceNumber(tx, now);
          return tx.invoice.create({
            data: {
              number,
              customerId: sub.customerId,
              subscriptionId: sub.id,
              periodStart,
              periodEnd,
              issueDate: now,
              dueDate,
              subtotal: totals.subtotal,
              discount: totals.discount,
              ppn: totals.ppn,
              adminFee: totals.adminFee,
              penalty: 0,
              total: totals.total,
              amountPaid: 0,
              status: InvoiceStatus.UNPAID,
              notes: `Tagihan ${sub.package.name} periode ${String(monthIndex + 1).padStart(2, '0')}/${year}`,
            },
          });
        });

        await this.audit(
          'billing.invoice_created',
          'Invoice',
          invoice.id,
          { number: invoice.number, customerId: sub.customerId, total: totals.total },
          undefined,
          sub.customerId,
        );

        // Antrikan pengingat WhatsApp (worker notifikasi milik agen lain).
        await this.notificationsQueue
          .add(
            'invoice-reminder',
            { kind: 'invoice-reminder', invoiceId: invoice.id },
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: 100,
            },
          )
          .catch((err: unknown) =>
            this.logger.warn(`Gagal antrekan pengingat WA invoice ${invoice.number}: ${String(err)}`),
          );

        created++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Gagal generate invoice subscription ${sub?.id}: ${String(err)}`,
        );
      }
    }

    this.logger.log(
      `generateMonthlyInvoices ${year}-${String(monthIndex + 1).padStart(2, '0')}: created=${created} skipped=${skipped} failed=${failed}`,
    );
    return { created, skipped, failed };
  }

  // ------------------------------------------------------------------ //
  // Denda keterlambatan
  // ------------------------------------------------------------------ //

  /**
   * Terapkan denda sekali per invoice yang melewati dueDate + graceDays dan
   * belum pernah didenda (penalty = 0) serta belum ada pembayaran.
   */
  async applyPenalties(): Promise<{ penalized: number }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const invoices = await this.prisma.invoice.findMany({
      where: {
        status: { in: [InvoiceStatus.UNPAID, InvoiceStatus.OVERDUE, InvoiceStatus.PARTIAL] },
        penalty: 0,
        amountPaid: 0,
      },
      include: { customer: true },
    });

    const flatSetting = Number(await getSetting(this.prisma, 'PENALTY_FLAT', '0'));
    const percentSetting = Number(await getSetting(this.prisma, 'PENALTY_PERCENT', '5'));

    let penalized = 0;
    for (const inv of invoices) {
      try {
        if (!inv.customer || !inv.dueDate) continue;
        const graceDays = Number(inv.customer.graceDays) || 0;
        const deadline = new Date(inv.dueDate).getTime() + graceDays * DAY_MS;
        if (deadline >= today.getTime()) continue; // masih dalam masa tenggang

        const total = Number(inv.total);
        const penalty =
          flatSetting > 0
            ? Math.round(flatSetting)
            : Math.round((total * (Number.isFinite(percentSetting) ? percentSetting : 0)) / 100);
        if (penalty <= 0) continue;

        const updated = await this.prisma.$transaction(async (tx) => {
          const cur = await tx.invoice.findUnique({ where: { id: inv.id } });
          if (!cur || Number(cur.penalty) > 0) return null; // sudah didenda (idempotent)
          return tx.invoice.update({
            where: { id: inv.id },
            data: { penalty, total: Number(cur.total) + penalty },
          });
        });
        if (!updated) continue;

        await this.audit(
          'billing.penalty_applied',
          'Invoice',
          inv.id,
          { number: inv.number, penalty, newTotal: Number(updated.total) },
          undefined,
          inv.customerId,
        );

        try {
          const msg =
            `Denda keterlambatan ${formatRupiah(penalty)} telah ditambahkan ke tagihan ${inv.number}. ` +
            `Total menjadi ${formatRupiah(Number(updated.total))}. Segera lakukan pembayaran.`;
          await this.notifications.sendWhatsApp(inv.customer.phone, msg);
        } catch (err) {
          this.logger.warn(`Gagal kirim WA denda invoice ${inv.number}: ${String(err)}`);
        }

        penalized++;
      } catch (err) {
        this.logger.error(`Gagal terapkan denda invoice ${inv?.id}: ${String(err)}`);
      }
    }

    this.logger.log(`applyPenalties: penalized=${penalized}`);
    return { penalized };
  }

  // ------------------------------------------------------------------ //
  // Evaluasi tunggakan → isolasi / throttle
  // ------------------------------------------------------------------ //

  /**
   * Evaluasi invoice jatuh tempo per pelanggan (satu pelanggan diproses
   * sekali memakai invoice paling overdue):
   * - daysOverdue >= tier2 → isolasi via NetworkOrchestrator, status ISOLATED,
   *   invoice → OVERDUE, kirim WA tplIsolationNotice.
   * - daysOverdue >= tier1 → throttle 512/512 kbps + WA peringatan.
   */
  async evaluateOverdueAndIsolate(): Promise<{
    processed: number;
    isolated: number;
    throttled: number;
    failed: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tier1 = Number(await getSetting(this.prisma, 'ISOLATION_TIER1_DAYS', '3'));
    const tier2 = Number(await getSetting(this.prisma, 'ISOLATION_TIER2_DAYS', '7'));

    const invoices = await this.prisma.invoice.findMany({
      where: {
        status: { in: [InvoiceStatus.UNPAID, InvoiceStatus.OVERDUE] },
        dueDate: { lt: today },
      },
      include: { customer: true },
      orderBy: { dueDate: 'asc' },
    });

    // Dedupe per pelanggan: ambil invoice paling overdue (dueDate paling lama).
    const byCustomer = new Map<number, (typeof invoices)[number]>();
    for (const inv of invoices) {
      if (!inv.customer) continue;
      if (!byCustomer.has(inv.customerId)) byCustomer.set(inv.customerId, inv);
    }

    let processed = 0;
    let isolated = 0;
    let throttled = 0;
    let failed = 0;

    for (const [customerId, inv] of byCustomer) {
      try {
        processed++;
        const daysOverdue = Math.floor(
          (today.getTime() - new Date(inv.dueDate).getTime()) / DAY_MS,
        );
        const customerRef: CustomerRef = {
          id: String(inv.customer.id),
          customerNo: inv.customer.customerNo,
          name: inv.customer.name,
          phone: inv.customer.phone,
        };
        const invoiceRef = toInvoiceRef(inv);

        if (daysOverdue >= tier2) {
          await this.networkOrchestrator.isolateCustomer(
            customerId,
            `Overdue ${daysOverdue} hari - ${inv.number}`,
          );
          await this.prisma.customer.update({
            where: { id: customerId },
            data: { status: CustomerStatus.ISOLATED },
          });
          await this.prisma.invoice.updateMany({
            where: {
              customerId,
              status: { in: [InvoiceStatus.UNPAID, InvoiceStatus.OVERDUE] },
              dueDate: { lt: today },
            },
            data: { status: InvoiceStatus.OVERDUE },
          });
          const msg = this.notifications.tplIsolationNotice(customerRef, invoiceRef);
          await this.notifications.sendWhatsApp(inv.customer.phone, msg).catch((err: unknown) =>
            this.logger.warn(`Gagal kirim WA isolasi ke ${inv.customer.phone}: ${String(err)}`),
          );
          await this.audit(
            'billing.customer_isolated',
            'Customer',
            customerId,
            { invoiceNumber: inv.number, daysOverdue },
            undefined,
            customerId,
          );
          isolated++;
          this.logger.log(
            `Pelanggan ${inv.customer.customerNo} diisolir (tunggakan ${daysOverdue} hari)`,
          );
        } else if (daysOverdue >= tier1) {
          await this.networkOrchestrator.throttleCustomer(customerId, 512, 512);
          const msg =
            `⚠️ Peringatan: tagihan ${inv.number} (${formatRupiah(Number(inv.total))}) sudah ${daysOverdue} hari jatuh tempo. ` +
            `Layanan akan diisolir otomatis. Segera bayar.`;
          await this.notifications.sendWhatsApp(inv.customer.phone, msg).catch((err: unknown) =>
            this.logger.warn(`Gagal kirim WA peringatan ke ${inv.customer.phone}: ${String(err)}`),
          );
          await this.audit(
            'billing.customer_throttled',
            'Customer',
            customerId,
            { invoiceNumber: inv.number, daysOverdue },
            undefined,
            customerId,
          );
          throttled++;
          this.logger.log(
            `Pelanggan ${inv.customer.customerNo} di-throttle (tunggakan ${daysOverdue} hari)`,
          );
        }
      } catch (err) {
        failed++;
        this.logger.error(
          `Gagal evaluasi tunggakan pelanggan ${customerId}: ${String(err)}`,
        );
      }
    }

    this.logger.log(
      `evaluateOverdueAndIsolate: processed=${processed} isolated=${isolated} throttled=${throttled} failed=${failed}`,
    );
    return { processed, isolated, throttled, failed };
  }

  // ------------------------------------------------------------------ //
  // Pembayaran manual (kasir)
  // ------------------------------------------------------------------ //

  /**
   * Catat pembayaran manual.
   * - CASH: langsung PAID + settlement dalam satu transaksi, lalu reaktivasi.
   * - BANK_TRANSFER: PENDING dulu (butuh bukti), dikonfirmasi via
   *   confirmTransferPayment oleh kasir.
   */
  async recordManualPayment(
    dto: {
      invoiceId: number;
      amount: number;
      method: 'CASH' | 'BANK_TRANSFER';
      channel?: string;
      reference?: string;
      proofUrl?: string;
      notes?: string;
    },
    cashierId: number,
  ): Promise<PaymentRow> {
    if (!Number.isFinite(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('Nominal pembayaran harus lebih dari 0');
    }
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: dto.invoiceId },
      include: { customer: true },
    });
    if (!invoice) throw new NotFoundException('Invoice tidak ditemukan');
    if (invoice.status === InvoiceStatus.CANCELLED) {
      throw new BadRequestException('Invoice sudah dibatalkan');
    }
    if (invoice.status === InvoiceStatus.PAID) {
      throw new BadRequestException('Invoice sudah lunas');
    }

    if (dto.method === 'CASH') {
      const reference = sanitizeReference(dto.reference ?? `CASH-${Date.now()}`);
      const payment = await this.prisma.$transaction(async (tx) => {
        const created = await tx.payment.create({
          data: {
            invoiceId: invoice.id,
            customerId: invoice.customerId,
            method: PaymentMethod.CASH,
            channel: dto.channel ?? 'CASH',
            amount: dto.amount,
            reference,
            status: PaymentStatus.PAID,
            paidAt: new Date(),
            confirmedById: cashierId,
          },
        });
        await this.applySettlementTx(tx, created as PaymentRow, dto.amount);
        return created;
      });

      const freshPayment = await this.prisma.payment.findUnique({
        where: { id: payment.id },
      });
      if (freshPayment && freshPayment.invoiceId) {
        const freshInvoice = await this.prisma.invoice.findUnique({
          where: { id: freshPayment.invoiceId },
        });
        if (freshInvoice) {
          await this.postSettlementActions(
            invoice.customerId,
            toPaymentRef(freshPayment),
            toInvoiceRef(freshInvoice),
          );
        }
      }
      await this.audit(
        'billing.manual_payment_recorded',
        'Payment',
        payment.id,
        {
          method: 'CASH',
          amount: dto.amount,
          invoiceNumber: invoice.number,
          notes: dto.notes,
        },
        cashierId,
        invoice.customerId,
      );
      return payment as PaymentRow;
    }

    // BANK_TRANSFER: PENDING menunggu konfirmasi kasir.
    const reference = sanitizeReference(dto.reference ?? `TRF-${Date.now()}`);
    const payment = await this.prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        method: PaymentMethod.BANK_TRANSFER,
        channel: dto.channel ?? 'BANK_TRANSFER',
        amount: dto.amount,
        reference,
        proofUrl: dto.proofUrl,
        status: PaymentStatus.PENDING,
      },
    });
    await this.audit(
      'billing.transfer_recorded',
      'Payment',
      payment.id,
      { amount: dto.amount, invoiceNumber: invoice.number, notes: dto.notes },
      cashierId,
      invoice.customerId,
    );
    return payment as PaymentRow;
  }

  /**
   * Kasir mengonfirmasi bukti transfer: payment PENDING/BANK_TRANSFER →
   * PAID + settlement dalam satu transaksi, lalu reaktivasi bila perlu.
   */
  async confirmTransferPayment(paymentId: number, cashierId: number): Promise<PaymentRow> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { invoice: true },
    });
    if (!payment) throw new NotFoundException('Payment tidak ditemukan');
    if (payment.status !== PaymentStatus.PENDING || payment.method !== PaymentMethod.BANK_TRANSFER) {
      throw new BadRequestException(
        'Hanya pembayaran transfer berstatus PENDING yang bisa dikonfirmasi',
      );
    }
    if (!payment.invoiceId) {
      throw new BadRequestException('Payment tidak terhubung ke invoice');
    }

    const settled = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.PAID, paidAt: new Date(), confirmedById: cashierId },
      });
      await this.applySettlementTx(tx, updated as PaymentRow, Number(payment.amount));
      return updated;
    });

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: payment.invoiceId },
    });
    if (invoice) {
      await this.postSettlementActions(
        payment.customerId,
        toPaymentRef(settled),
        toInvoiceRef(invoice),
      );
    }
    await this.audit(
      'billing.transfer_confirmed',
      'Payment',
      paymentId,
      { amount: Number(payment.amount), invoiceNumber: invoice?.number },
      cashierId,
      payment.customerId,
    );
    return settled as PaymentRow;
  }
}

// ---------------------------------------------------------------------- //
// Mapper Prisma → *Ref (port notifikasi memakai id string & Number()).
// ---------------------------------------------------------------------- //

function toCustomerRef(customer: {
  id: number;
  customerNo: string;
  name: string;
  phone: string;
}): CustomerRef {
  return {
    id: String(customer.id),
    customerNo: customer.customerNo,
    name: customer.name,
    phone: customer.phone,
  };
}

function toInvoiceRef(invoice: {
  id: number;
  number: string;
  total: unknown;
  amountPaid: unknown;
  dueDate: Date;
  periodStart: Date;
  periodEnd: Date;
  status: unknown;
}): InvoiceRef {
  return {
    id: String(invoice.id),
    number: invoice.number,
    total: Number(invoice.total),
    amountPaid: Number(invoice.amountPaid),
    dueDate: new Date(invoice.dueDate),
    periodStart: new Date(invoice.periodStart),
    periodEnd: new Date(invoice.periodEnd),
    status: String(invoice.status),
  };
}

function toPaymentRef(payment: {
  id: number;
  reference: string;
  amount: unknown;
  method: unknown;
  channel: string | null;
  paidAt: Date | null;
}): PaymentRef {
  return {
    id: String(payment.id),
    reference: payment.reference,
    amount: Number(payment.amount),
    method: String(payment.method),
    channel: payment.channel,
    paidAt: payment.paidAt,
  };
}

// Re-ekspor helper agar tidak ada unused warning bila tree-shaken.
export { toCustomerRef };
