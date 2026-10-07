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
import { InvoiceService } from './invoice.service';
import { BillingAutomationService } from '../../services/billing-automation.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { InvoiceFilterDto } from './dto/invoice-filter.dto';
import { PayInvoiceDto } from './dto/pay-invoice.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';

/**
 * Mengambil ID pengguna dari request yang sudah diautentikasi.
 * JwtStrategy menaruh { userId, email, role } di req.user.
 */
function getUserId(req: Request): number {
  const user = (req as Request & { user?: Partial<AuthUser> }).user;
  const id = Number(user?.userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestException('Token autentikasi tidak valid');
  }
  return id;
}

@Controller('billing/invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'CASHIER', 'CS')
export class InvoiceController {
  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly billingAutomation: BillingAutomationService,
  ) {}

  @Post()
  create(@Body() dto: CreateInvoiceDto, @Req() req: Request) {
    return this.invoiceService.create(dto, getUserId(req));
  }

  @Get()
  findAll(@Query() filter: InvoiceFilterDto) {
    return this.invoiceService.findAll(filter);
  }

  /** Tunggakan pelanggan — diletakkan sebelum :id agar tidak bentrok rute. */
  @Get('customer/:customerId/outstanding')
  outstanding(
    @Param('customerId', ParseIntPipe) customerId: number,
  ) {
    return this.invoiceService.getOutstanding(customerId);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.invoiceService.findOne(id);
  }

  @Post(':id/cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.invoiceService.cancel(id, getUserId(req));
  }

  /**
   * Catat pembayaran manual untuk sebuah invoice.
   * CASH langsung melunasi; BANK_TRANSFER menunggu konfirmasi kasir.
   */
  @Post(':id/payments')
  recordPayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PayInvoiceDto,
    @Req() req: Request,
  ) {
    return this.billingAutomation.recordManualPayment(
      { ...dto, invoiceId: id },
      getUserId(req),
    );
  }
}
