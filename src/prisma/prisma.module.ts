import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Modul Prisma global — cukup import sekali di AppModule, lalu inject
 * PrismaService di service manapun tanpa import ulang.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
