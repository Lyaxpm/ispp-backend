import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/**
 * Body untuk POST /billing/invoices/:id/payments.
 * invoiceId diambil dari path, bukan body.
 */
export class PayInvoiceDto {
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
