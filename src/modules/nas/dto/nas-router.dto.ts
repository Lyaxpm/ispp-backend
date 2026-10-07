import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { NasType } from '@prisma/client';

const NAS_TYPES = Object.values(NasType);

/** Body untuk POST /nas-routers. Password dikirim plain, disimpan terenkripsi. */
export class CreateNasRouterDto {
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(255)
  host!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  @Type(() => Number)
  apiPort?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  password!: string;

  @IsOptional()
  @IsBoolean()
  useTls?: boolean;

  @IsOptional()
  @IsIn([...NAS_TYPES])
  type?: NasType;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;
}

/** Body untuk PATCH /nas-routers/:id — semua field opsional. */
export class UpdateNasRouterDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  @Type(() => Number)
  apiPort?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  password?: string;

  @IsOptional()
  @IsBoolean()
  useTls?: boolean;

  @IsOptional()
  @IsIn([...NAS_TYPES])
  type?: NasType;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
