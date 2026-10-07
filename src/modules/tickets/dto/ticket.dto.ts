import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { TicketPriority, TicketStatus } from '@prisma/client';

/** Prioritas versi frontend (CRITICAL) dipetakan ke URGENT di service. */
export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const TICKET_STATUSES = Object.values(TicketStatus);

export class TicketFilterDto {
  @IsOptional()
  @IsIn([...TICKET_STATUSES])
  status?: TicketStatus;

  @IsOptional()
  @IsString()
  search?: string;

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

export class CreateTicketDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  customerId?: number;

  @IsString()
  @MinLength(5)
  @MaxLength(160)
  title!: string;

  @IsString()
  @MinLength(5)
  description!: string;

  @IsOptional()
  @IsIn([...TICKET_PRIORITIES])
  priority?: (typeof TICKET_PRIORITIES)[number];
}

export class UpdateTicketDto {
  @IsOptional()
  @IsIn([...TICKET_STATUSES])
  status?: TicketStatus;

  @IsOptional()
  @IsIn([...TICKET_PRIORITIES])
  priority?: (typeof TICKET_PRIORITIES)[number];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  assignedToId?: number;
}

export { TicketPriority, TicketStatus };
