import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsIP,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { IpPoolType, VlanPurpose } from '@prisma/client';

const CIDR_PATTERN =
  /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/([0-9]|[12][0-9]|3[0-2])$/;

export class CreatePoolDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsString()
  @Matches(CIDR_PATTERN, { message: 'cidr harus format IPv4 valid, mis. 10.10.0.0/24.' })
  cidr!: string;

  @IsOptional()
  @IsIP('4')
  gateway?: string;

  @IsOptional()
  @IsIP('4')
  dnsPrimary?: string;

  @IsOptional()
  @IsIP('4')
  dnsSecondary?: string;

  @IsOptional()
  @IsEnum(IpPoolType, { message: 'poolType harus PRIVATE|PUBLIC|CGNAT.' })
  poolType?: IpPoolType;

  @IsOptional()
  @IsInt()
  @Min(1)
  nasRouterId?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AllocateIpDto {
  @IsInt()
  @Min(1)
  customerId!: number;
}

export class ReserveIpDto {
  @IsIP('4', { message: 'ipAddress harus IPv4 valid.' })
  ipAddress!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateVlanDto {
  @IsInt()
  @Min(1)
  @Max(4094)
  vlanId!: number;

  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsEnum(VlanPurpose, { message: 'purpose harus INTERNET|IPTV|VOIP|MGMT.' })
  purpose?: VlanPurpose;

  @IsOptional()
  @IsInt()
  @Min(1)
  oltId?: number;
}

const MAC_PATTERN = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;

export class CreateStaticLeaseDto {
  @IsInt()
  @Min(1)
  customerId!: number;

  @IsString()
  @Matches(MAC_PATTERN, { message: 'macAddress harus format MAC valid (AA:BB:CC:DD:EE:FF).' })
  macAddress!: string;

  @IsIP('4', { message: 'ipAddress harus IPv4 valid.' })
  ipAddress!: string;

  @IsInt()
  @Min(1)
  nasRouterId!: number;
}
