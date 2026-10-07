import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';

const SN_PATTERN = /^[A-Za-z0-9]{8,32}$/;

export class ProvisionOnuDto {
  @IsInt()
  oltId!: number;

  /** Nama PON port, mis. "0/1" (slot/pon). */
  @IsString()
  @MinLength(1)
  ponPortName!: string;

  /** Serial number ONU, mis. HWTC1234ABCD. */
  @IsString()
  @Matches(SN_PATTERN, { message: 'SN ONU harus 8-32 karakter alfanumerik.' })
  sn!: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  vendor?: string;

  @IsOptional()
  @IsString()
  lineProfile?: string;

  @IsOptional()
  @IsString()
  serviceProfile?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4094)
  vlanId?: number;

  /** Override batas kecepatan (Mbps). Bila kosong: dari paket pelanggan / default. */
  @IsOptional()
  @IsInt()
  @Min(1)
  upMbps?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  downMbps?: number;
}

export class ReplaceOnuDto {
  @IsString()
  @Matches(SN_PATTERN, { message: 'SN ONU baru harus 8-32 karakter alfanumerik.' })
  newSn!: string;

  @IsOptional()
  @IsString()
  lineProfile?: string;

  @IsOptional()
  @IsString()
  serviceProfile?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4094)
  vlanId?: number;
}
