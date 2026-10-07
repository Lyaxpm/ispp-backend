import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { TicketsService } from './tickets.service';
import { CreateTicketDto, TicketFilterDto, UpdateTicketDto } from './dto/ticket.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';

function getUserId(req: Request): number {
  const user = (req as Request & { user?: Partial<AuthUser> }).user;
  const id = Number(user?.userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestException('Token autentikasi tidak valid');
  }
  return id;
}

@Controller('tickets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @Roles('ADMIN', 'NOC', 'CS', 'TECHNICIAN')
  findAll(@Query() filter: TicketFilterDto) {
    return this.tickets.findAll(filter);
  }

  @Get(':id')
  @Roles('ADMIN', 'NOC', 'CS', 'TECHNICIAN')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.tickets.findOne(id);
  }

  @Post()
  @Roles('ADMIN', 'NOC', 'CS')
  create(@Body() dto: CreateTicketDto, @Req() req: Request) {
    return this.tickets.create(dto, getUserId(req));
  }

  @Patch(':id')
  @Roles('ADMIN', 'NOC', 'TECHNICIAN')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTicketDto,
    @Req() req: Request,
  ) {
    return this.tickets.update(id, dto, getUserId(req));
  }
}
