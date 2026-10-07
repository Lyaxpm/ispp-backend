/**
 * Kontrak port notifikasi untuk platform billing ISP.
 *
 * Modul lain meng-inject port ini via `@Inject(NOTIFICATION_PORT)` untuk
 * mengirim pesan WhatsApp atau membangun template pesan berbahasa Indonesia.
 * Interface `*Ref` bersifat struktural — entity Prisma yang memiliki field
 * dengan nama & tipe yang sama dapat langsung dipakai tanpa konversi.
 */

export const NOTIFICATION_PORT = 'NotificationPort';

export interface CustomerRef {
  id: string;
  customerNo: string;
  name: string;
  phone: string;
}

export interface InvoiceRef {
  id: string;
  number: string;
  total: number;
  amountPaid: number;
  dueDate: Date;
  periodStart: Date;
  periodEnd: Date;
  status: string;
}

export interface PaymentRef {
  id: string;
  reference: string;
  amount: number;
  method: string;
  channel: string | null;
  paidAt: Date | null;
}

export abstract class NotificationPort {
  /** Kirim satu pesan teks WhatsApp ke nomor tujuan. */
  abstract sendWhatsApp(to: string, message: string): Promise<void>;

  /** Kirim pesan gangguan massal ke banyak nomor (batched, tidak throw). */
  abstract sendOutageAlert(phones: string[], message: string): Promise<void>;

  /** Template pengingat tagihan terbit. */
  abstract tplInvoiceReminder(customer: CustomerRef, invoice: InvoiceRef): string;

  /** Template bukti pembayaran diterima. */
  abstract tplPaymentReceipt(
    customer: CustomerRef,
    payment: PaymentRef,
    invoice: InvoiceRef,
  ): string;

  /** Template pemberitahuan isolir layanan. */
  abstract tplIsolationNotice(customer: CustomerRef, invoice: InvoiceRef): string;

  /** Template pemberitahuan layanan aktif kembali. */
  abstract tplActivationNotice(customer: CustomerRef): string;
}
