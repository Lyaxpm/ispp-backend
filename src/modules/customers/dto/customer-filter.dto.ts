import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CustomerStatus } from '@prisma/client';

const STATUSES = Object.values(CustomerStatus);

/**
 * Filter/pencarian/paginasi untuk GET /customers.
 * search mencakup: nama, nomor pelanggan, telepon, alamat, kode ODP.
 */
export class CustomerFilterDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: CustomerStatus;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  packageId?: number;

  @IsOptional()
  @IsString()
  odpCode?: string;

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
