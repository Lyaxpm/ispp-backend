import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { CustomersService } from './customers.service';
import { CustomerFilterDto } from './dto/customer-filter.dto';
import { IsolateCustomerDto, ThrottleCustomerDto } from './dto/customer-action.dto';
import { CreatePortalAccountDto, ResetPortalPasswordDto } from './dto/portal-account.dto';
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

/**
 * API pelanggan untuk dashboard & konsol NOC.
 * Aksi isolir/aktif/throttle/kick/reboot mengeksekusi orkestrasi jaringan
 * secara langsung (bukan via antrean) agar NOC mendapat umpan balik seketika.
 */
@Controller('customers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @Roles('ADMIN', 'NOC', 'CS', 'TECHNICIAN')
  findAll(@Query() filter: CustomerFilterDto) {
    return this.customers.findAll(filter);
  }

  @Get(':id')
  @Roles('ADMIN', 'NOC', 'CS', 'TECHNICIAN')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.customers.findOne(id);
  }

  @Post(':id/isolate')
  @Roles('ADMIN', 'NOC')
  isolate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: IsolateCustomerDto,
    @Req() req: Request,
  ) {
    return this.customers.isolate(id, dto.reason ?? 'Isolir manual dari NOC', getUserId(req));
  }

  @Post(':id/unisolate')
  @Roles('ADMIN', 'NOC')
  unisolate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.customers.unisolate(id, getUserId(req));
  }

  @Post(':id/throttle')
  @Roles('ADMIN', 'NOC')
  throttle(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ThrottleCustomerDto,
    @Req() req: Request,
  ) {
    return this.customers.throttle(id, dto.downKbps, dto.upKbps, getUserId(req));
  }

  @Post(':id/kick-session')
  @Roles('ADMIN', 'NOC')
  kickSession(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.customers.kickSession(id, getUserId(req));
  }

  @Post(':id/reboot-onu')
  @Roles('ADMIN', 'NOC', 'TECHNICIAN')
  rebootOnu(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.customers.rebootOnu(id, getUserId(req));
  }

  @Get(':id/account')
  @Roles('ADMIN', 'NOC', 'CS')
  portalAccount(@Param('id', ParseIntPipe) id: number) {
    return this.customers.getPortalAccount(id);
  }

  @Post(':id/account')
  @Roles('ADMIN', 'CS')
  createPortalAccount(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreatePortalAccountDto,
  ) {
    return this.customers.createPortalAccount(id, dto.email, dto.password);
  }

  @Post(':id/account/reset-password')
  @Roles('ADMIN', 'CS')
  resetPortalPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResetPortalPasswordDto,
  ) {
    return this.customers.resetPortalPassword(id, dto.newPassword);
  }
}
