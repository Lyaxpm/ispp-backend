import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/**
 * DTO untuk membuat invoice baru.
 * Dipakai oleh POST /invoices.
 */
export class CreateInvoiceDto {
  /** ID pelanggan yang ditagih. */
  @IsInt()
  @Type(() => Number)
  customerId!: number;

  /** ID langganan (opsional; wajib jika ingin harga diambil dari paket). */
  @IsInt()
  @IsOptional()
  @Type(() => Number)
  subscriptionId?: number;

  /** Awal periode tagihan (ISO 8601, mis. "2026-10-01"). */
  @IsDateString()
  periodStart!: string;

  /** Akhir periode tagihan (ISO 8601, mis. "2026-10-31"). */
  @IsDateString()
  periodEnd!: string;

  /** Harga manual; wajib jika tanpa subscriptionId. */
  @IsNumber()
  @Min(0)
  @IsOptional()
  priceOverride?: number;

  /** Diskon nominal (IDR) sebelum PPN. */
  @IsNumber()
  @Min(0)
  @IsOptional()
  discount?: number;

  /** Kode voucher yang akan diterapkan (opsional). */
  @IsString()
  @IsOptional()
  voucherCode?: string;

  /** Catatan bebas pada invoice. */
  @IsString()
  @IsOptional()
  notes?: string;
}
