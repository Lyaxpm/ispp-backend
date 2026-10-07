import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CustomerJwtGuard } from '../customer-auth/guards/customer-jwt.guard';
import { CurrentCustomer } from '../customer-auth/decorators/current-customer.decorator';
import { CustomerAuthUser } from '../customer-auth/customer-auth.types';
import { PortalService } from './portal.service';
import { ChangePppoePasswordDto, CreatePortalTicketDto } from './dto/portal.dto';

@Controller('portal')
@UseGuards(CustomerJwtGuard)
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('profile')
  profile(@CurrentCustomer() customer: CustomerAuthUser | undefined) {
    return this.portal.profile(customer!.customerId);
  }

  @Get('invoices')
  invoices(@CurrentCustomer() customer: CustomerAuthUser | undefined) {
    return this.portal.invoices(customer!.customerId);
  }

  @Get('invoices/:id')
  invoiceDetail(
    @CurrentCustomer() customer: CustomerAuthUser | undefined,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.portal.invoiceDetail(customer!.customerId, id);
  }

  @Get('tickets')
  tickets(@CurrentCustomer() customer: CustomerAuthUser | undefined) {
    return this.portal.ticketsList(customer!.customerId);
  }

  @Post('tickets')
  createTicket(
    @CurrentCustomer() customer: CustomerAuthUser | undefined,
    @Body() dto: CreatePortalTicketDto,
  ) {
    return this.portal.createTicket(customer!.customerId, dto);
  }

  /**
   * Ganti password WiFi/PPPoE. Selalu HTTP 200 dengan body {ok, message}
   * agar frontend bisa menampilkan hasilnya tanpa menangani error HTTP.
   */
  @Post('change-pppoe-password')
  @HttpCode(HttpStatus.OK)
  changePppoePassword(
    @CurrentCustomer() customer: CustomerAuthUser | undefined,
    @Body() dto: ChangePppoePasswordDto,
  ) {
    return this.portal.changePppoePassword(customer!.customerId, dto.newPassword);
  }
}
