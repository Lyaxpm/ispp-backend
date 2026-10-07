import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuditModule } from './modules/audit/audit.module';
import { ServicesModule } from './services/services.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { BillingModule } from './modules/billing/billing.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NetworkModule } from './network/network.module';
import { RadiusModule } from './modules/radius/radius.module';
import { GisModule } from './modules/gis/gis.module';
import { OltModule } from './modules/olt/olt.module';
import { IpamModule } from './modules/ipam/ipam.module';
import { Tr069Module } from './modules/tr069/tr069.module';
import { CustomersModule } from './modules/customers/customers.module';
import { PackagesModule } from './modules/packages/packages.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { WorkersModule } from './workers/workers.module';
import { registerAllQueues } from './workers/queues';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('REDIS_URL') },
      }),
    }),
    PrismaModule,
    AuthModule,
    AuditModule,

    // === FEATURE MODULES ===
    ServicesModule, // @Global — BillingAutomationService
    NotificationsModule, // WhatsApp/Telegram + token NOTIFICATION_PORT
    BillingModule, // Invoice CRUD
    PaymentsModule, // Midtrans/Xendit/manual + webhooks
    NetworkModule, // DriverFactory, NetworkOrchestratorService, RadiusCoA
    RadiusModule, // FreeRADIUS PostgreSQL sync
    GisModule, // GIS/FTTH spasial + impact engine
    OltModule, // Provisioning OLT/ONU
    IpamModule, // IP pool, VLAN, static lease
    Tr069Module, // GenieACS adapter
    CustomersModule, // Pelanggan + aksi NOC
    PackagesModule, // Katalog paket
    DashboardModule, // Statistik & grafik pendapatan
    TicketsModule, // Tiket insiden
    InventoryModule, // Stok gudang
    WorkersModule, // BullMQ workers + jadwal repeatable

    // Daftarkan semua queue BullMQ (billing, network-ops,
    // notifications, monitoring) agar @InjectQueue tersedia.
    ...registerAllQueues(),
  ],
})
export class AppModule {}
