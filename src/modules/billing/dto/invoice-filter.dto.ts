import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/** Daftar status invoice yang valid. */
export const INVOICE_STATUSES = [
  'DRAFT',
  'UNPAID',
  'PARTIAL',
  'PAID',
  'OVERDUE',
  'CANCELLED',
] as const;

/**
 * DTO filter/paginasi untuk GET /invoices.
 */
export class InvoiceFilterDto {
  @IsOptional()
  @IsIn([...INVOICE_STATUSES])
  status?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  customerId?: number;

  /** Tahun periode tagihan, mis. 2026. */
  @IsOptional()
  @IsInt()
  @Min(2000)
  @Type(() => Number)
  year?: number;

  /** Bulan periode tagihan (1-12). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  @Type(() => Number)
  month?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;
}
