import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
// Kontrak: disediakan modul auth (agen lain).
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RoleName } from '@prisma/client';
import { GenieAcsService } from './genieacs.service';
import { FirmwarePushDto, SetPppoeDto, SetWifiDto } from './dto/tr069.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tr069')
export class Tr069Controller {
  constructor(private readonly acs: GenieAcsService) {}

  /** Detail device GenieACS (termasuk parameter yang sudah ter-cache). */
  @Get('devices/:id')
  @Roles(RoleName.ADMIN, RoleName.NOC, RoleName.TECHNICIAN)
  getDevice(@Param('id') id: string) {
    return this.acs.getDevice(id);
  }

  /** Set SSID + password WiFi dari jarak jauh. */
  @Post('devices/:id/wifi')
  @Roles(RoleName.ADMIN, RoleName.NOC, RoleName.TECHNICIAN)
  setWifi(@Param('id') id: string, @Body() dto: SetWifiDto) {
    return this.acs.setWifiSsid(id, dto.ssid, dto.password);
  }

  /** Set kredensial PPPoE WAN dari jarak jauh. */
  @Post('devices/:id/pppoe')
  @Roles(RoleName.ADMIN, RoleName.NOC, RoleName.TECHNICIAN)
  setPppoe(@Param('id') id: string, @Body() dto: SetPppoeDto) {
    return this.acs.setPppoeWan(id, dto.username, dto.password);
  }

  /** Reboot CPE dari jarak jauh. */
  @Post('devices/:id/reboot')
  @Roles(RoleName.ADMIN, RoleName.NOC, RoleName.TECHNICIAN)
  reboot(@Param('id') id: string) {
    return this.acs.reboot(id);
  }

  /** Factory reset CPE dari jarak jauh. Berbahaya — batasi ke ADMIN/NOC. */
  @Post('devices/:id/factory-reset')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  factoryReset(@Param('id') id: string) {
    return this.acs.factoryReset(id);
  }

  /** Statistik optik (RX/TX dBm) bila CPE melaporkannya via TR-069. */
  @Get('devices/:id/optical')
  @Roles(RoleName.ADMIN, RoleName.NOC, RoleName.TECHNICIAN)
  optical(@Param('id') id: string) {
    return this.acs.getOpticalStats(id);
  }

  /** Push firmware massal (konkurensi dibatasi 5). */
  @Post('firmware-push')
  @Roles(RoleName.ADMIN, RoleName.NOC)
  firmwarePush(@Body() dto: FirmwarePushDto) {
    return this.acs.pushFirmware(dto.deviceIds, dto.firmwareUrl);
  }
}
