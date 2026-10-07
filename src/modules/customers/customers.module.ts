import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { NetworkModule } from '../../network/network.module';
import { RadiusModule } from '../radius/radius.module';
import { OltModule } from '../olt/olt.module';

@Module({
  imports: [NetworkModule, RadiusModule, OltModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
