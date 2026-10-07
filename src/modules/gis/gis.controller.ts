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
import { CreateOdcDto, CreateOdpDto } from '../olt/dto/create-odp.dto';
import { GisService } from './gis.service';
import { NearestOdpQueryDto } from './dto/nearest-odp.dto';
import { OutageImpactDto } from './dto/outage-impact.dto';
import { AssignOdpDto } from './dto/assign-odp.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('gis')
export class GisController {
  constructor(private readonly gis: GisService) {}

  // ----------------------------- GIS read endpoints -----------------------------

  /** ODP aktif terdekat: GET /gis/nearest-odp?lat=-6.2&lng=106.8&radius=500 */
  @Get('nearest-odp')
  nearestOdp(@Query() q: NearestOdpQueryDto) {
    return this.gis.nearestOdp(q.lat, q.lng, q.radius);
  }

  /** Self-coverage check: GET /gis/coverage?lat=&lng= */
  @Get('coverage')
  coverage(@Query() q: NearestOdpQueryDto) {
    return this.gis.coverage(q.lat, q.lng);
  }

  /** Pohon topologi FTTH per OLT. */
  @Get('topology/:oltId')
  topology(@Param('oltId', ParseIntPipe) oltId: number) {
    return this.gis.topology(oltId);
  }

  /** Export GeoJSON untuk peta: /gis/geojson/olt|odc|odp|customer|cable */
  @Get('geojson/:layer')
  geojson(@Param('layer') layer: 'olt' | 'odc' | 'odp' | 'customer' | 'cable') {
    return this.gis.geojson(layer);
  }

  /** Ringkasan jumlah node. */
  @Get('summary')
  summary() {
    return this.gis.nodeSummary();
  }

  // ----------------------------- outage impact -----------------------------

  /**
   * Hitung dampak gangguan + kirim notifikasi WA massal (throttle 30 mnt).
   * Hanya ADMIN & NOC.
   */
  @Post('outage-impact')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  outageImpact(@Body() dto: OutageImpactDto) {
    return this.gis.outageImpact(dto.nodeType, dto.nodeId);
  }

  // ----------------------------- customer <-> ODP port -----------------------------

  /** Assign pelanggan ke port ODP yang tersedia. */
  @Post('customers/:id/assign-odp')
  @Roles(RoleName.ADMIN, RoleName.NOC, RoleName.TECHNICIAN)
  assignOdp(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignOdpDto,
  ) {
    return this.gis.assignOdpPort(id, dto.odpId);
  }

  /** Lepaskan port ODP pelanggan. */
  @Delete('customers/:id/assign-odp')
  @Roles(RoleName.ADMIN, RoleName.NOC, RoleName.TECHNICIAN)
  releaseOdp(@Param('id', ParseIntPipe) id: number) {
    return this.gis.releaseOdpPort(id);
  }

  // ----------------------------- ODP / ODC CRUD -----------------------------

  @Get('odps')
  listOdps(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.gis.listOdps({
      status,
      search,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Post('odps')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  createOdp(@Body() dto: CreateOdpDto) {
    return this.gis.createOdp(dto);
  }

  @Patch('odps/:id')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  updateOdp(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateOdpDto>) {
    return this.gis.updateOdp(id, dto);
  }

  @Delete('odps/:id')
  @Roles(RoleName.ADMIN)
  deleteOdp(@Param('id', ParseIntPipe) id: number) {
    return this.gis.deleteOdp(id);
  }

  @Get('odcs')
  listOdcs(@Query('search') search?: string) {
    return this.gis.listOdcs({ search });
  }

  @Post('odcs')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  createOdc(@Body() dto: CreateOdcDto) {
    return this.gis.createOdc(dto);
  }

  @Patch('odcs/:id')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  updateOdc(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateOdcDto>) {
    return this.gis.updateOdc(id, dto);
  }

  @Get('olts')
  listOlts(@Query('search') search?: string) {
    return this.gis.listOlts({ search });
  }
}
