import { Module } from '@nestjs/common';
import { OltController } from './olt.controller';
import { OltService } from './olt.service';
import { NetworkModule } from '../../network/network.module';

/**
 * OltModule: CRUD OLT/PON Port/ODC/ODP/ONU + provisioning & zero-touch swap.
 *
 * Dependensi: DriverFactory (provider dari modul network, agen lain).
 * Pastikan modul yang mendaftarkan DriverFactory diimpor di AppModule
 * (atau jadikan @Global) agar injeksi di OltService terpenuhi.
 */
@Module({
  imports: [NetworkModule],
  controllers: [OltController],
  providers: [OltService],
  exports: [OltService],
})
export class OltModule {}
