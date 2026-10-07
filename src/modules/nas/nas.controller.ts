import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { NasService } from './nas.service';
import { CreateNasRouterDto, UpdateNasRouterDto } from './dto/nas-router.dto';

@Controller('nas-routers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NasController {
  constructor(private readonly nas: NasService) {}

  @Get()
  @Roles('ADMIN', 'NOC', 'TECHNICIAN')
  findAll() {
    return this.nas.findAll();
  }

  @Get(':id')
  @Roles('ADMIN', 'NOC', 'TECHNICIAN')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.nas.findOne(id);
  }

  @Post()
  @Roles('ADMIN')
  create(@Body() dto: CreateNasRouterDto) {
    return this.nas.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateNasRouterDto) {
    return this.nas.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.nas.remove(id);
  }

  /**
   * Uji koneksi ke perangkat. Selalu HTTP 200 dengan body {ok: true|false, ...}
   * agar frontend bisa menampilkan hasilnya tanpa menangani error HTTP.
   */
  @Post(':id/test-connection')
  @Roles('ADMIN', 'NOC', 'TECHNICIAN')
  @HttpCode(HttpStatus.OK)
  testConnection(@Param('id', ParseIntPipe) id: number) {
    return this.nas.testConnection(id);
  }
}
