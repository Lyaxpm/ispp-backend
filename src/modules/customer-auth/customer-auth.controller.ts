import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CustomerJwtGuard } from './guards/customer-jwt.guard';
import { CurrentCustomer } from './decorators/current-customer.decorator';
import { CustomerAuthUser } from './customer-auth.types';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerChangePasswordDto, CustomerLoginDto } from './dto/customer-auth.dto';

@Controller('customer-auth')
export class CustomerAuthController {
  constructor(private readonly auth: CustomerAuthService) {}

  @Post('login')
  login(@Body() dto: CustomerLoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Get('me')
  @UseGuards(CustomerJwtGuard)
  me(@CurrentCustomer() customer: CustomerAuthUser | undefined) {
    return this.auth.me(customer!.customerId);
  }

  @Post('change-password')
  @UseGuards(CustomerJwtGuard)
  changePassword(
    @CurrentCustomer() customer: CustomerAuthUser | undefined,
    @Body() dto: CustomerChangePasswordDto,
  ) {
    return this.auth.changePassword(customer!.customerId, dto.oldPassword, dto.newPassword);
  }
}
