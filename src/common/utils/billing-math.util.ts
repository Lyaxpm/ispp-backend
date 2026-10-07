/**
 * billing-math.util.ts
 * Matematika uang bersama untuk seluruh modul billing.
 *
 * Prinsip:
 * - Semua nominal dalam rupiah dibulatkan ke integer terdekat (Math.round),
 *   TIDAK ada pecahan sen.
 * - Prisma menyimpan uang sebagai Decimal; koersikan dengan Number() sebelum
 *   masuk ke fungsi-fungsi di sini.
 * - Fungsi ini murni (pure) kecuali getSetting/getSecret/allocateInvoiceNumber
 *   yang membaca Setting dari database.
 */
import * as crypto from 'crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import { decrypt } from './crypto.util';

export interface TotalsInput {
  price: number;
  discount?: number;
  ppnRatePercent?: number;
  adminFee?: number;
  penalty?: number;
}

export interface TotalsResult {
  subtotal: number;
  discount: number;
  ppn: number;
  adminFee: number;
  penalty: number;
  total: number;
}

const clampNonNegative = (n: number): number =>
  Math.max(0, Math.round(Number.isFinite(n) ? n : 0));

/**
 * Hitung komponen tagihan:
 *   subtotal = round(price)
 *   dpp      = subtotal - discount
 *   ppn      = round(dpp * ppnRatePercent / 100)
 *   total    = subtotal - discount + ppn + adminFee + penalty
 * Semua komponen dijepit >= 0.
 */
export function computeTotals(input: TotalsInput): TotalsResult {
  const subtotal = clampNonNegative(input.price);
  const discount = Math.min(clampNonNegative(input.discount ?? 0), subtotal);
  const dpp = subtotal - discount;
  const ppnRate = Number(input.ppnRatePercent ?? 0);
  const ppn = clampNonNegative((dpp * (Number.isFinite(ppnRate) ? ppnRate : 0)) / 100);
  const adminFee = clampNonNegative(input.adminFee ?? 0);
  const penalty = clampNonNegative(input.penalty ?? 0);
  const total = subtotal - discount + ppn + adminFee + penalty;
  return { subtotal, discount, ppn, adminFee, penalty, total };
}

/** Format nominal ke "Rp 1.500.000". */
export function formatRupiah(amount: number | string): string {
  const n = Math.round(Number(amount));
  const safe = Number.isFinite(n) ? n : 0;
  return 'Rp ' + new Intl.NumberFormat('id-ID').format(safe);
}

/** Nomor invoice: INV/2026/10/00042 */
export function buildInvoiceNumber(seq: number, d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const n = String(Math.max(1, Math.floor(seq))).padStart(5, '0');
  return `INV/${yyyy}/${mm}/${n}`;
}

/** Jumlah hari dalam bulan. monthIndex0: 0 = Januari. */
export function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

/** Baca Setting sebagai string; kembalikan fallback bila key tidak ada. */
export async function getSetting(
  prisma: PrismaService,
  key: string,
  fallback: string,
): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? fallback;
}

/**
 * Baca secret dari Setting. Nilai yang diawali 'enc:' didekripsi dengan
 * crypto.util.decrypt; nilai polos dipakai apa adanya; terakhir fallback ke
 * process.env[key]. Melempar Error bila tidak dikonfigurasi.
 */
export async function getSecret(prisma: PrismaService, key: string): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const raw = (row?.value ?? '').trim();
  if (raw.startsWith('enc:')) return decrypt(raw.slice(4));
  if (raw.length > 0) return raw;
  const env = (process.env[key] ?? '').trim();
  if (env.length > 0) return env;
  throw new Error(`Secret ${key} not configured`);
}

/**
 * Sanitasi referensi pembayaran untuk gateway (Midtrans/Xendit melarang
 * karakter seperti '/'): ganti karakter ilegal dengan '-', maks 64 karakter.
 */
export function sanitizeReference(s: string): string {
  return s.replace(/[^a-zA-Z0-9\-_]/g, '-').slice(0, 64);
}

/**
 * Alokasi nomor invoice atomik di dalam transaksi Prisma yang diberikan.
 *
 * CATATAN KONKURENSI (single-writer assumption):
 * read-modify-write Setting 'INVOICE_SEQ' ini aman selama pemanggilannya
 * tunggal dalam satu waktu — yaitu worker generate-monthly bulanan + invoice
 * manual sesekali. Karena alokasi terjadi DI DALAM $transaction bersamaan
 * dengan create invoice, dua pemanggil bersamaan bisa membaca seq yang sama
 * lalu upsert nilai yang sama (lost update) → nomor duplikat.
 * Jika beban naik ke banyak writer konkuren, ganti dengan sequence di
 * database (mis. tabel counter + SELECT ... FOR UPDATE) atau PostgreSQL
 * sequence native.
 */
export async function allocateInvoiceNumber(
  tx: Prisma.TransactionClient,
  issueDate: Date,
): Promise<string> {
  const row = await tx.setting.findUnique({ where: { key: 'INVOICE_SEQ' } });
  const current = parseInt(row?.value ?? '0', 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  await tx.setting.upsert({
    where: { key: 'INVOICE_SEQ' },
    create: { key: 'INVOICE_SEQ', value: String(next) },
    update: { value: String(next) },
  });
  return buildInvoiceNumber(next, issueDate);
}

/** Perbandingan string waktu-konstan untuk signature/token webhook. */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
