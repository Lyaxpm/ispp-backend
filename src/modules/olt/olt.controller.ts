import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
// Kontrak: disediakan modul auth (agen lain).
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RoleName } from '@prisma/client';
import { OltService } from './olt.service';
import { CreateOltDto, UpdateOltDto } from './dto/create-olt.dto';
import { CreateOdcDto, CreateOdpDto } from './dto/create-odp.dto';
import { ProvisionOnuDto, ReplaceOnuDto } from './dto/provision-onu.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('olt')
export class OltController {
  constructor(private readonly olt: OltService) {}

  // -------------------------------- OLT --------------------------------

  @Post()
  @Roles(RoleName.ADMIN, RoleName.NOC)
  createOlt(@Body() dto: CreateOltDto) {
    return this.olt.createOlt(dto);
  }

  @Get()
  listOlts(@Query('search') search?: string) {
    return this.olt.listOlts({ search });
  }

  @Get(':id')
  getOlt(@Param('id', ParseIntPipe) id: number) {
    return this.olt.getOlt(id);
  }

  @Patch(':id')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  updateOlt(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateOltDto) {
    return this.olt.updateOlt(id, dto);
  }

  @Delete(':id')
  @Roles(RoleName.ADMIN)
  deleteOlt(@Param('id', ParseIntPipe) id: number) {
    return this.olt.deleteOlt(id);
  }

  /** Scan ONU yang belum terkonfigurasi di OLT. */
  @Post(':id/discover')
  @Roles(RoleName.ADMIN, RoleName.NOC, RoleName.TECHNICIAN)
  discover(@Param('id', ParseIntPipe) id: number) {
    return this.olt.discoverUnconfigured(id);
  }

  // -------------------------------- ODC --------------------------------

  @Post('odc')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  createOdc(@Body() dto: CreateOdcDto) {
    return this.olt.createOdc(dto);
  }

  @Get('odc/list')
  listOdcs(@Query('search') search?: string) {
    return this.olt.listOdcs({ search });
  }

  @Patch('odc/:id')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  updateOdc(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateOdcDto>,
  ) {
    return this.olt.updateOdc(id, dto);
  }

  // -------------------------------- ODP --------------------------------

  @Post('odp')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  createOdp(@Body() dto: CreateOdpDto) {
    return this.olt.createOdp(dto);
  }

  @Get('odp/list')
  listOdps(@Query('search') search?: string, @Query('status') status?: string) {
    return this.olt.listOdps({ search, status });
  }

  @Patch('odp/:id')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  updateOdp(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateOdpDto>,
  ) {
    return this.olt.updateOdp(id, dto);
  }

  @Delete('odp/:id')
  @Roles(RoleName.ADMIN)
  deleteOdp(@Param('id', ParseIntPipe) id: number) {
    return this.olt.deleteOdp(id);
  }

  // -------------------------------- ONU --------------------------------

  @Get('onu/list')
  listOnus(
    @Query('oltId') oltId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.olt.listOnus({
      oltId: oltId ? Number(oltId) : undefined,
      status,
      search,
    });
  }

  /** Provisioning ONU baru untuk pelanggan. */
  @Post('customers/:customerId/provision-onu')
  @Roles(RoleName.ADMIN, RoleName.NOC, RoleName.TECHNICIAN)
  provisionOnu(
    @Param('customerId', ParseIntPipe) customerId: number,
    @Body() dto: ProvisionOnuDto,
  ) {
    return this.olt.provisionOnu(customerId, dto);
  }

  /** Zero-touch swap: ganti ONU rusak tanpa konfigurasi ulang manual. */
  @Post('customers/:customerId/replace-onu')
  @Roles(RoleName.ADMIN, RoleName.NOC, RoleName.TECHNICIAN)
  replaceOnu(
    @Param('customerId', ParseIntPipe) customerId: number,
    @Body() dto: ReplaceOnuDto,
  ) {
    return this.olt.replaceOnuZeroTouch(customerId, dto);
  }

  @Post('onu/:id/reboot')
  @Roles(RoleName.ADMIN, RoleName.NOC, RoleName.TECHNICIAN)
  rebootOnu(@Param('id', ParseIntPipe) id: number) {
    return this.olt.rebootOnu(id);
  }

  @Get('onu/:id/optical')
  opticalPower(@Param('id', ParseIntPipe) id: number) {
    return this.olt.readOpticalPower(id);
  }

  @Get('onu/:id/status')
  onuStatus(@Param('id', ParseIntPipe) id: number) {
    return this.olt.onuStatus(id);
  }

  @Delete('onu/:id')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  deleteOnu(@Param('id', ParseIntPipe) id: number) {
    return this.olt.deleteOnu(id);
  }
}
