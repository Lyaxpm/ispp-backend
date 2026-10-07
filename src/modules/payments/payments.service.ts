import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingAutomationService } from '../../services/billing-automation.service';
import { sanitizeReference } from '../../common/utils/billing-math.util';

interface PayableInvoice {
  invoiceId: number;
  customerId: number;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string;
  number: string;
  remaining: number;
}

/** Kanal pembayaran yang tersedia beserta estimasi biaya admin. */
export interface PaymentChannel {
  code: string;
  name: string;
  fee: number;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billingAutomation: BillingAutomationService,
  ) {}

  /**
   * Memuat invoice yang masih bisa dibayar beserta sisa tagihannya.
   * Melempar error jika invoice tidak ada / sudah lunas / dibatalkan.
   */
  private async loadPayableInvoice(invoiceId: number): Promise<PayableInvoice> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { customer: true },
    });
    if (!invoice) {
      throw new NotFoundException('Invoice tidak ditemukan');
    }
    if (invoice.status === 'PAID') {
      throw new BadRequestException('Invoice sudah lunas');
    }
    if (invoice.status === 'CANCELLED') {
      throw new BadRequestException('Invoice sudah dibatalkan');
    }

    const remaining = Number(invoice.total) - Number(invoice.amountPaid);
    if (remaining <= 0) {
      throw new BadRequestException('Tidak ada sisa tagihan pada invoice ini');
    }

    return {
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      customerName: invoice.customer.name,
      customerEmail: invoice.customer.email,
      customerPhone: invoice.customer.phone,
      number: invoice.number,
      remaining,
    };
  }

  /**
   * Membuat transaksi Midtrans Snap untuk sisa tagihan sebuah invoice.
   * Mengembalikan snap token + URL redirect untuk ditampilkan ke pelanggan.
   */
  async createMidtransSnap(invoiceId: number) {
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    if (!serverKey) {
      throw new BadGatewayException(
        'Konfigurasi Midtrans belum lengkap (MIDTRANS_SERVER_KEY kosong)',
      );
    }

    const inv = await this.loadPayableInvoice(invoiceId);
    const reference = sanitizeReference(`MID-${inv.number}-${Date.now()}`);

    const payment = await this.prisma.payment.create({
      data: {
        invoiceId: inv.invoiceId,
        customerId: inv.customerId,
        method: 'GATEWAY',
        channel: 'MIDTRANS_SNAP',
        amount: inv.remaining,
        reference,
        status: 'PENDING',
      },
    });

    const baseUrl =
      process.env.MIDTRANS_IS_PRODUCTION === 'true'
        ? 'https://app.midtrans.com'
        : 'https://app.sandbox.midtrans.com';

    try {
      const res = await axios.post(
        `${baseUrl}/snap/v1/transactions`,
        {
          transaction_details: {
            order_id: reference,
            gross_amount: Math.round(inv.remaining),
          },
          customer_details: {
            first_name: inv.customerName,
            email: inv.customerEmail ?? undefined,
            phone: inv.customerPhone,
          },
          item_details: [
            {
              id: inv.invoiceId,
              price: Math.round(inv.remaining),
              quantity: 1,
              name: `Tagihan ${inv.number}`.slice(0, 50),
            },
          ],
          callbacks: { finish: process.env.PAYMENT_FINISH_URL },
        },
        {
          headers: {
            Authorization:
              'Basic ' + Buffer.from(serverKey + ':').toString('base64'),
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );

      const { token, redirect_url } = res.data as {
        token: string;
        redirect_url: string;
      };

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { rawWebhook: { snapToken: token } },
      });

      this.logger.log(
        `Transaksi Snap Midtrans dibuat: ref ${reference} invoice ${inv.number}`,
      );
      return {
        snapToken: token,
        redirectUrl: redirect_url,
        reference,
        amount: inv.remaining,
      };
    } catch (err) {
      const message =
        axios.isAxiosError(err) && err.response
          ? `Midtrans ${err.response.status}: ${JSON.stringify(err.response.data)}`
          : err instanceof Error
            ? err.message
            : String(err);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', rawWebhook: { error: message } },
      });
      this.logger.error(
        `Gagal membuat transaksi Midtrans untuk invoice ${inv.number}: ${message}`,
      );
      throw new BadGatewayException('Gagal membuat transaksi Midtrans');
    }
  }

  /**
   * Membuat Xendit Invoice untuk sisa tagihan sebuah invoice.
   * Mengembalikan URL invoice Xendit untuk dibayar pelanggan.
   */
  async createXenditInvoice(invoiceId: number) {
    const secretKey = process.env.XENDIT_SECRET_KEY;
    if (!secretKey) {
      throw new BadGatewayException(
        'Konfigurasi Xendit belum lengkap (XENDIT_SECRET_KEY kosong)',
      );
    }

    const inv = await this.loadPayableInvoice(invoiceId);
    const reference = sanitizeReference(`XND-${inv.number}-${Date.now()}`);

    const payment = await this.prisma.payment.create({
      data: {
        invoiceId: inv.invoiceId,
        customerId: inv.customerId,
        method: 'GATEWAY',
        channel: 'XENDIT_INVOICE',
        amount: inv.remaining,
        reference,
        status: 'PENDING',
      },
    });

    try {
      const res = await axios.post(
        'https://api.xendit.co/v2/invoices',
        {
          external_id: reference,
          amount: Math.round(inv.remaining),
          payer_email: inv.customerEmail ?? undefined,
          description: `Tagihan Internet ${inv.number}`.slice(0, 255),
          invoice_duration: 86400,
          success_redirect_url: process.env.PAYMENT_FINISH_URL,
          failure_redirect_url: process.env.PAYMENT_FAILED_URL,
        },
        {
          headers: {
            Authorization:
              'Basic ' + Buffer.from(secretKey + ':').toString('base64'),
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );

      const { invoice_url } = res.data as { invoice_url: string };

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { rawWebhook: { xenditInvoiceUrl: invoice_url } },
      });

      this.logger.log(
        `Invoice Xendit dibuat: ref ${reference} invoice ${inv.number}`,
      );
      return {
        invoiceUrl: invoice_url,
        externalId: reference,
        amount: inv.remaining,
      };
    } catch (err) {
      const message =
        axios.isAxiosError(err) && err.response
          ? `Xendit ${err.response.status}: ${JSON.stringify(err.response.data)}`
          : err instanceof Error
            ? err.message
            : String(err);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', rawWebhook: { error: message } },
      });
      this.logger.error(
        `Gagal membuat invoice Xendit untuk invoice ${inv.number}: ${message}`,
      );
      throw new BadGatewayException('Gagal membuat invoice Xendit');
    }
  }

  /** Menyimpan URL bukti pembayaran hasil unggahan file. */
  async attachProof(paymentId: number, filename: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) {
      throw new NotFoundException('Pembayaran tidak ditemukan');
    }

    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { proofUrl: `/uploads/proofs/${filename}` },
    });

    this.logger.log(
      `Bukti pembayaran diunggah untuk payment ${payment.reference}`,
    );
    return updated;
  }

  /** Daftar kanal pembayaran yang didukung. */
  getPaymentChannels(): PaymentChannel[] {
    return [
      { code: 'BCA_VA', name: 'BCA Virtual Account', fee: 4000 },
      { code: 'BRI_VA', name: 'BRI Virtual Account', fee: 4000 },
      { code: 'MANDIRI_VA', name: 'Mandiri Virtual Account', fee: 4000 },
      { code: 'QRIS', name: 'QRIS', fee: 2500 },
      { code: 'GOPAY', name: 'GoPay', fee: 3000 },
      { code: 'OVO', name: 'OVO', fee: 3000 },
      { code: 'DANA', name: 'DANA', fee: 3000 },
      { code: 'ALFAMART', name: 'Alfamart', fee: 4000 },
      { code: 'INDOMARET', name: 'Indomaret', fee: 4000 },
      { code: 'CASH', name: 'Tunai (Kasir/Kolektor)', fee: 0 },
      { code: 'BANK_TRANSFER', name: 'Transfer Bank Manual', fee: 0 },
    ];
  }

  /**
   * Mencocokkan mutasi bank dengan pembayaran berstatus PENDING.
   * Entri yang cocok langsung diselesaikan via BillingAutomationService;
   * yang tidak cocok dikembalikan dengan alasan penolakannya.
   */
  async reconcileBankStatement(
    entries: { reference: string; amount: number; date: string }[],
  ): Promise<{
    matched: string[];
    unmatched: { reference: string; amount: number; reason: string }[];
  }> {
    const matched: string[] = [];
    const unmatched: { reference: string; amount: number; reason: string }[] =
      [];

    for (const entry of entries) {
      try {
        const payment = await this.prisma.payment.findFirst({
          where: { reference: entry.reference, status: 'PENDING' },
        });
        if (!payment) {
          unmatched.push({
            reference: entry.reference,
            amount: entry.amount,
            reason: 'Pembayaran tidak ditemukan atau tidak berstatus pending',
          });
          continue;
        }
        if (Math.abs(Number(payment.amount) - entry.amount) > 0.5) {
          unmatched.push({
            reference: entry.reference,
            amount: entry.amount,
            reason: `Nominal tidak cocok (tagihan ${Number(payment.amount)}, mutasi ${entry.amount})`,
          });
          continue;
        }
        if (!payment.invoiceId) {
          unmatched.push({
            reference: entry.reference,
            amount: entry.amount,
            reason: 'Pembayaran tidak terhubung ke invoice mana pun',
          });
          continue;
        }

        await this.billingAutomation.settlePayment(
          {
            id: payment.id,
            invoiceId: payment.invoiceId,
            customerId: payment.customerId,
            amount: Number(payment.amount),
          },
          entry.amount,
        );
        matched.push(entry.reference);
        this.logger.log(`Rekonsiliasi bank cocok: ${entry.reference}`);
      } catch (err) {
        unmatched.push({
          reference: entry.reference,
          amount: entry.amount,
          reason:
            err instanceof Error ? err.message : 'Gagal memproses entri ini',
        });
      }
    }

    this.logger.log(
      `Rekonsiliasi bank selesai: ${matched.length} cocok, ${unmatched.length} tidak cocok`,
    );
    return { matched, unmatched };
  }
}
