import {
  IsEnum,
  IsIn,
  IsInt,
  IsIP,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { NodeStatus, OltVendor } from '@prisma/client';

export class CreateOltDto {
  @IsString()
  @MinLength(2, { message: 'Nama OLT minimal 2 karakter.' })
  name!: string;

  @IsEnum(OltVendor, { message: 'vendor harus HUAWEI|ZTE|FIBERHOME|HSGQ|CDATA|HIOSO.' })
  vendor!: OltVendor;

  @IsString()
  @MinLength(1, { message: 'Model OLT wajib diisi.' })
  model!: string;

  @IsIP('4', { message: 'mgmtIp harus IPv4 valid.' })
  mgmtIp!: string;

  @IsOptional()
  @IsString()
  snmpCommunity?: string;

  /** Versi SNMP sebagai angka: 2 (v2c) atau 3. */
  @IsOptional()
  @IsIn([2, 3], { message: 'snmpVersion harus 2 atau 3.' })
  snmpVersion?: number;

  @IsOptional()
  @IsString()
  sshUsername?: string;

  @IsOptional()
  @IsString()
  sshPassword?: string; // disimpan terenkripsi (sshPasswordEncrypted)

  @IsOptional()
  @IsString()
  popLocation?: string;

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
  @Max(32)
  slotCount!: number;

  @IsInt()
  @Min(1)
  @Max(32)
  ponPerSlot!: number;

  @IsOptional()
  @IsString()
  uplinkInfo?: string;

  @IsOptional()
  @IsEnum(NodeStatus)
  status?: NodeStatus;
}

export class UpdateOltDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEnum(OltVendor) vendor?: OltVendor;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsIP('4') mgmtIp?: string;
  @IsOptional() @IsString() snmpCommunity?: string;
  @IsOptional() @IsIn([2, 3]) snmpVersion?: number;
  @IsOptional() @IsString() sshUsername?: string;
  @IsOptional() @IsString() sshPassword?: string;
  @IsOptional() @IsString() popLocation?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
  @IsOptional() @IsString() uplinkInfo?: string;
  @IsOptional() @IsEnum(NodeStatus) status?: NodeStatus;
}
