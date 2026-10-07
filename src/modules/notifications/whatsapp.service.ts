import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CustomerRef,
  InvoiceRef,
  NotificationPort,
  PaymentRef,
} from './ports/notification.port';

/** Backoff antar percobaan kirim: 1s, 2s, 4s. */
const RETRY_BACKOFF_MS = [1000, 2000, 4000];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;
const BATCH_SIZE = 20;
const BATCH_PAUSE_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class WhatsAppService implements NotificationPort {
  private readonly logger = new Logger(WhatsAppService.name);
  private configErrorLogged = false;

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------
  // Konfigurasi
  // ------------------------------------------------------------------

  private getConfig(): { gatewayUrl: string; apiKey: string } {
    const gatewayUrl = process.env.WA_GATEWAY_URL;
    const apiKey = process.env.WA_GATEWAY_API_KEY;
    const missing: string[] = [];
    if (!gatewayUrl) missing.push('WA_GATEWAY_URL');
    if (!apiKey) missing.push('WA_GATEWAY_API_KEY');
    if (missing.length > 0) {
      if (!this.configErrorLogged) {
        this.logger.error(
          `Konfigurasi WhatsApp gateway belum lengkap. Env yang hilang: ${missing.join(', ')}`,
        );
        this.configErrorLogged = true;
      }
      throw new Error(
        `Konfigurasi WhatsApp gateway belum lengkap, env yang hilang: ${missing.join(', ')}`,
      );
    }
    // Dilempar di atas bila ada yang hilang — aman untuk non-null assertion.
    return { gatewayUrl: gatewayUrl as string, apiKey: apiKey as string };
  }

  // ------------------------------------------------------------------
  // Util nomor telepon Indonesia
  // ------------------------------------------------------------------

  private normalizePhone(to: string): string {
    const digits = (to ?? '').replace(/\D/g, '');
    if (digits.length < 9) {
      throw new Error(`Nomor WhatsApp tidak valid: "${to}"`);
    }
    if (digits.startsWith('62')) return digits;
    if (digits.startsWith('0')) return `62${digits.slice(1)}`;
    if (digits.startsWith('8')) return `62${digits}`;
    throw new Error(`Nomor WhatsApp tidak valid (bukan nomor Indonesia): "${to}"`);
  }

  // ------------------------------------------------------------------
  // Pengiriman
  // ------------------------------------------------------------------

  /** True untuk error yang layak di-retry: gangguan jaringan/timeout/5xx. 4xx tidak di-retry. */
  private isRetryable(err: unknown): boolean {
    if (axios.isAxiosError(err)) {
      if (err.response) {
        return err.response.status >= 500;
      }
      // Tidak ada response: network error / timeout / DNS — layak retry.
      return true;
    }
    return false;
  }

  private async persistLog(args: {
    recipient: string;
    messageLength: number;
    attempt: number;
    status: 'SENT' | 'FAILED';
    error: string | null;
  }): Promise<void> {
    try {
      await this.prisma.notificationLog.create({
        data: {
          channel: 'WHATSAPP',
          recipient: args.recipient,
          template: 'send-text',
          payload: {
            to: args.recipient,
            messageLength: args.messageLength,
            attempt: args.attempt,
          },
          status: args.status,
          sentAt: args.status === 'SENT' ? new Date() : undefined,
          error: args.error ?? undefined,
        },
      });
    } catch (logErr) {
      // Kegagalan menulis log tidak boleh menutupi hasil pengiriman sebenarnya.
      this.logger.warn(
        `Gagal menyimpan NotificationLog (WHATSAPP/${args.status}): ${
          logErr instanceof Error ? logErr.message : String(logErr)
        }`,
      );
    }
  }

  async sendWhatsApp(to: string, message: string): Promise<void> {
    const { gatewayUrl, apiKey } = this.getConfig();
    const normalized = this.normalizePhone(to);
    const url = `${gatewayUrl.replace(/\/+$/, '')}/send-text`;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await axios.post(
          url,
          { to: normalized, message },
          {
            timeout: 15000,
            headers: {
              'X-Api-Key': apiKey,
              'Content-Type': 'application/json',
            },
          },
        );
        await this.persistLog({
          recipient: normalized,
          messageLength: message.length,
          attempt,
          status: 'SENT',
          error: null,
        });
        this.logger.log(`Pesan WhatsApp terkirim ke ${normalized} (percobaan ${attempt}).`);
        return;
      } catch (err) {
        lastError = err;
        const message_ = err instanceof Error ? err.message : String(err);
        await this.persistLog({
          recipient: normalized,
          messageLength: message.length,
          attempt,
          status: 'FAILED',
          error: message_,
        });

        const retryable = this.isRetryable(err);
        if (!retryable) {
          this.logger.warn(
            `Gagal kirim WhatsApp ke ${normalized} (tidak di-retry): ${message_}`,
          );
          throw err;
        }
        if (attempt === MAX_ATTEMPTS) {
          this.logger.error(
            `Gagal kirim WhatsApp ke ${normalized} setelah ${MAX_ATTEMPTS} percobaan: ${message_}`,
          );
          throw err;
        }
        const waitMs = RETRY_BACKOFF_MS[attempt - 1];
        this.logger.warn(
          `Gagal kirim WhatsApp ke ${normalized} (percobaan ${attempt}), retry dalam ${waitMs}ms: ${message_}`,
        );
        await sleep(waitMs);
      }
    }
    // Tidak seharusnya tercapai; pengaman untuk TypeScript strict.
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async sendOutageAlert(phones: string[], message: string): Promise<void> {
    // Dedupe berdasarkan nomor yang sudah dinormalisasi.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const phone of phones) {
      try {
        const normalized = this.normalizePhone(phone);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          unique.push(normalized);
        }
      } catch (err) {
        this.logger.warn(
          `Nomor dilewati pada outage alert (tidak valid): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const batches: string[][] = [];
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      batches.push(unique.slice(i, i + BATCH_SIZE));
    }

    const failures: { batch: number; phone: string; error: string }[] = [];
    for (let b = 0; b < batches.length; b++) {
      for (const phone of batches[b]) {
        try {
          await this.sendWhatsApp(phone, message);
        } catch (err) {
          failures.push({
            batch: b + 1,
            phone,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (b < batches.length - 1) {
        await sleep(BATCH_PAUSE_MS);
      }
    }

    if (failures.length > 0) {
      const detail = failures
        .slice(0, 5)
        .map((f) => `batch ${f.batch} ${f.phone}: ${f.error}`)
        .join(' | ');
      this.logger.error(
        `Outage alert selesai dengan kegagalan parsial: ${failures.length}/${unique.length} gagal dalam ${batches.length} batch. Contoh: ${detail}`,
      );
    } else {
      this.logger.log(
        `Outage alert terkirim ke ${unique.length} penerima dalam ${batches.length} batch.`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Formatter
  // ------------------------------------------------------------------

  /** Format Rupiah; coerce karena Prisma dapat mengembalikan Decimal. */
  private formatRupiah(n: number | string | { toString(): string } | null | undefined): string {
    const value = n === null || n === undefined ? NaN : Number(n);
    if (!Number.isFinite(value)) return 'Rp 0';
    return `Rp ${new Intl.NumberFormat('id-ID').format(Math.round(value))}`;
  }

  /** "7 Okt 2026" */
  private formatDate(d: Date): string {
    return new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(d));
  }

  /** "7 Okt 2026, 19.09" */
  private formatDateTime(d: Date): string {
    return new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(d));
  }

  /** "Okt 2026" atau "Okt 2026 - Nov 2026" bila periode lintas bulan. */
  private formatPeriod(start: Date, end: Date): string {
    const fmt = new Intl.DateTimeFormat('id-ID', { month: 'short', year: 'numeric' });
    const s = fmt.format(new Date(start));
    const e = fmt.format(new Date(end));
    return s === e ? s : `${s} - ${e}`;
  }

  // ------------------------------------------------------------------
  // Template pesan (Bahasa Indonesia)
  // ------------------------------------------------------------------

  tplInvoiceReminder(customer: CustomerRef, invoice: InvoiceRef): string {
    return [
      '*[GenNet ISP]*',
      `Halo ${customer.name} (${customer.customerNo}),`,
      '',
      'Tagihan internet Anda telah terbit:',
      `No: ${invoice.number}`,
      `Periode: ${this.formatPeriod(invoice.periodStart, invoice.periodEnd)}`,
      `Total: ${this.formatRupiah(invoice.total)}`,
      `Jatuh tempo: ${this.formatDate(invoice.dueDate)}`,
      '',
      'Bayar via VA/QRIS/e-wallet atau hubungi kasir. Abaikan jika sudah membayar.',
    ].join('\n');
  }

  tplPaymentReceipt(customer: CustomerRef, payment: PaymentRef, invoice: InvoiceRef): string {
    const methodLine = payment.channel ? `${payment.method} ${payment.channel}` : payment.method;
    const paidAt = payment.paidAt ?? new Date();
    const remaining = Number(invoice.total) - Number(invoice.amountPaid);
    return [
      '✅ *Pembayaran Diterima*',
      `Halo ${customer.name},`,
      '',
      'Kami menerima pembayaran:',
      `No. Tagihan: ${invoice.number}`,
      `Jumlah: ${this.formatRupiah(payment.amount)}`,
      `Metode: ${methodLine}`,
      `Ref: ${payment.reference}`,
      `Waktu: ${this.formatDateTime(paidAt)}`,
      `Sisa tagihan: ${this.formatRupiah(remaining)}`,
      '',
      'Terima kasih 🙏',
    ].join('\n');
  }

  tplIsolationNotice(customer: CustomerRef, invoice: InvoiceRef): string {
    return [
      '⚠️ *Pemberitahuan Isolir*',
      `Halo ${customer.name},`,
      '',
      `Layanan internet Anda diisolir karena tagihan ${invoice.number} (${this.formatRupiah(invoice.total)}) melewati jatuh tempo ${this.formatDate(invoice.dueDate)}.`,
      '',
      'Segera lakukan pembayaran untuk mengaktifkan kembali layanan otomatis.',
    ].join('\n');
  }

  tplActivationNotice(customer: CustomerRef): string {
    return [
      '✅ *Layanan Aktif Kembali*',
      `Halo ${customer.name},`,
      '',
      'Internet Anda sudah aktif kembali. Terima kasih atas pembayarannya 🙏',
    ].join('\n');
  }
}
