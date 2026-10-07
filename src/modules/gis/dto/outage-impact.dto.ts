import { IsEnum, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export enum OutageNodeType {
  OLT = 'OLT',
  PON_PORT = 'PON_PORT',
  ODC = 'ODC',
  ODP = 'ODP',
}

export class OutageImpactDto {
  @IsEnum(OutageNodeType, {
    message: 'nodeType harus salah satu dari: OLT, PON_PORT, ODC, ODP.',
  })
  nodeType!: OutageNodeType;

  @Type(() => Number)
  @IsInt({ message: 'nodeId harus berupa integer.' })
  @Min(1, { message: 'nodeId minimal 1.' })
  nodeId!: number;
}
