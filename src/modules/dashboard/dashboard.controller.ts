import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'NOC', 'CS', 'CASHIER')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('stats')
  getStats() {
    return this.dashboard.getStats();
  }

  @Get('revenue-chart')
  getRevenueChart(@Query('months') months?: string) {
    const n = months ? Number(months) : 6;
    return this.dashboard.getRevenueChart(Number.isFinite(n) ? n : 6);
  }
}
