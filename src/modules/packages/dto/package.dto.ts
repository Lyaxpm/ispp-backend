import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { BillingType, ServiceType } from '@prisma/client';

const SERVICE_TYPES = Object.values(ServiceType);
const BILLING_TYPES = Object.values(BillingType);

/** Body untuk POST /packages. */
export class CreatePackageDto {
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name!: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  downloadMbps!: number;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  uploadMbps!: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  validityDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  fupGb?: number;

  @IsIn([...SERVICE_TYPES])
  serviceType!: ServiceType;

  @IsIn([...BILLING_TYPES])
  billingType!: BillingType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  installFee?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  setupFee?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  mikrotikProfile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  radiusRateLimit?: string;
}

/** Body untuk PATCH /packages/:id — semua field opsional. */
export class UpdatePackageDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  downloadMbps?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  uploadMbps?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  validityDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  fupGb?: number;

  @IsOptional()
  @IsIn([...SERVICE_TYPES])
  serviceType?: ServiceType;

  @IsOptional()
  @IsIn([...BILLING_TYPES])
  billingType?: BillingType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  installFee?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  setupFee?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  mikrotikProfile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  radiusRateLimit?: string;
}
