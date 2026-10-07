import { Module } from '@nestjs/common';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { TicketsModule } from '../tickets/tickets.module';
import { RadiusModule } from '../radius/radius.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

@Module({
  imports: [
    CustomerAuthModule, // CustomerJwtGuard untuk proteksi endpoint portal
    TicketsModule, // TicketsService untuk pembuatan tiket
    RadiusModule, // RadiusSyncService untuk sinkronisasi password PPPoE
  ],
  controllers: [PortalController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}
