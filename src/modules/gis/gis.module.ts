import { Module } from '@nestjs/common';
import { GisController } from './gis.controller';
import { GisService } from './gis.service';
import { GisFtthService } from '../../services/gis-ftth.service';
import { OltModule } from '../olt/olt.module';

/**
 * GisModule menyediakan:
 * - GisFtthService: logika spasial PostGIS + impact engine (diekspos untuk
 *   worker & service lain).
 * - GisService: wrapper tipis untuk controller.
 *
 * Dependensi: OltModule (CRUD ODP/ODC/OLT), NotificationsModule (token
 * NOTIFICATION_PORT — injeksi @Optional di GisFtthService, modul boleh
 * belum ada saat bootstrap).
 */
@Module({
  imports: [OltModule],
  controllers: [GisController],
  providers: [GisService, GisFtthService],
  exports: [GisService, GisFtthService],
})
export class GisModule {}
