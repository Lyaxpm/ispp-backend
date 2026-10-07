import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
// Kontrak: disediakan modul auth (agen lain).
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RoleName } from '@prisma/client';
import { IpamService } from './ipam.service';
import {
  AllocateIpDto,
  CreatePoolDto,
  CreateStaticLeaseDto,
  CreateVlanDto,
  ReserveIpDto,
} from './dto/ipam.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ipam')
export class IpamController {
  constructor(private readonly ipam: IpamService) {}

  // -------------------------------- pools --------------------------------

  @Post('pools')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  createPool(@Body() dto: CreatePoolDto) {
    return this.ipam.createPool(dto);
  }

  @Get('pools')
  listPools(@Query('activeOnly') activeOnly?: string) {
    return this.ipam.listPools(activeOnly === 'true');
  }

  @Get('pools/:id')
  getPool(@Param('id', ParseIntPipe) id: number) {
    return this.ipam.getPool(id);
  }

  @Get('pools/:id/utilization')
  utilization(@Param('id', ParseIntPipe) id: number) {
    return this.ipam.getPoolUtilization(id);
  }

  @Delete('pools/:id')
  @Roles(RoleName.ADMIN)
  deletePool(@Param('id', ParseIntPipe) id: number) {
    return this.ipam.deletePool(id);
  }

  /** Alokasikan 1 IP ke pelanggan. */
  @Post('pools/:id/allocate')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  allocate(@Param('id', ParseIntPipe) id: number, @Body() dto: AllocateIpDto) {
    return this.ipam.allocateIp(id, dto);
  }

  /** Reserve satu IP agar tidak ikut alokasi otomatis. */
  @Post('pools/:id/reserve')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  reserve(@Param('id', ParseIntPipe) id: number, @Body() dto: ReserveIpDto) {
    return this.ipam.reserveIp(id, dto);
  }

  /** Lepaskan IP milik pelanggan. */
  @Post('release')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  release(@Body() dto: AllocateIpDto) {
    return this.ipam.releaseIp(dto.customerId);
  }

  // -------------------------------- VLAN --------------------------------

  @Post('vlans')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  createVlan(@Body() dto: CreateVlanDto) {
    return this.ipam.createVlan(dto);
  }

  @Get('vlans')
  listVlans(@Query('oltId') oltId?: string) {
    return this.ipam.listVlans(oltId ? Number(oltId) : undefined);
  }

  @Delete('vlans/:id')
  @Roles(RoleName.ADMIN)
  deleteVlan(@Param('id', ParseIntPipe) id: number) {
    return this.ipam.deleteVlan(id);
  }

  // -------------------------------- static lease --------------------------------

  @Post('static-leases')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  createStaticLease(@Body() dto: CreateStaticLeaseDto) {
    return this.ipam.createStaticLease(dto);
  }

  @Get('static-leases')
  listStaticLeases(@Query('nasRouterId') nasRouterId?: string) {
    return this.ipam.listStaticLeases(nasRouterId ? Number(nasRouterId) : undefined);
  }

  @Delete('static-leases/:id')
  @Roles(RoleName.ADMIN)
  deleteStaticLease(@Param('id', ParseIntPipe) id: number) {
    return this.ipam.deleteStaticLease(id);
  }
}
