import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/**
 * DTO pencatatan pembayaran manual (tunai / transfer bank).
 * Dipakai oleh POST /invoices/:id/record-payment dan POST /payments/manual.
 */
export class RecordPaymentDto {
  /** ID invoice yang dibayar. */
  @IsInt()
  @Type(() => Number)
  invoiceId!: number;

  /** Nominal pembayaran (IDR), minimal Rp1.000. */
  @IsNumber()
  @Min(1000)
  amount!: number;

  /** Metode pembayaran manual. */
  @IsIn(['CASH', 'BANK_TRANSFER'])
  method!: 'CASH' | 'BANK_TRANSFER';

  /** Kanal pembayaran, mis. "BCA", "Kasir Cabang A". */
  @IsOptional()
  @IsString()
  channel?: string;

  /** Nomor referensi / bukti transfer. */
  @IsOptional()
  @IsString()
  reference?: string;

  /** URL bukti pembayaran yang sudah diunggah. */
  @IsOptional()
  @IsString()
  proofUrl?: string;

  /** Catatan kasir. */
  @IsOptional()
  @IsString()
  notes?: string;
}
