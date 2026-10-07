import { Module } from '@nestjs/common';
import { NetworkModule } from '../../network/network.module';
import { NasController } from './nas.controller';
import { NasService } from './nas.service';

@Module({
  imports: [NetworkModule], // DriverFactory untuk uji koneksi perangkat
  controllers: [NasController],
  providers: [NasService],
  exports: [NasService],
})
export class NasModule {}
