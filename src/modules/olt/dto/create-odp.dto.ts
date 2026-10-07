import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { NodeStatus } from '@prisma/client';

export class CreateOdcDto {
  @IsOptional()
  @IsString()
  code?: string; // bila kosong: auto ODC-<area>-###

  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsInt()
  ponPortId?: number;

  @IsOptional()
  @IsString()
  areaCode?: string; // untuk penomoran kode otomatis

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsInt()
  @Min(1)
  @Max(1024)
  capacity!: number;

  @IsOptional()
  @IsEnum(NodeStatus)
  status?: NodeStatus;

  /** URL/path foto ODC (disimpan bila skema mendukung kolom foto). */
  @IsOptional()
  @IsString()
  photoUrl?: string;
}

export class CreateOdpDto {
  @IsOptional()
  @IsString()
  code?: string; // bila kosong: auto ODP-<area>-###

  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsInt()
  odcId?: number;

  @IsOptional()
  @IsInt()
  ponPortId?: number;

  @IsOptional()
  @IsString()
  areaCode?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsInt()
  @Min(1)
  @Max(64)
  capacity!: number; // jumlah port ODP -> auto-generate OdpPort

  @IsOptional()
  @IsEnum(NodeStatus)
  status?: NodeStatus;

  @IsOptional()
  @IsString()
  photoUrl?: string;
}
