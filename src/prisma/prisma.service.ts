import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaService global — satu-satunya akses database di seluruh aplikasi.
 * Import PrismaModule (global) di modul manapun untuk menggunakannya.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  enableShutdownHooks(app: INestApplication): void {
    // $on('beforeExit') tidak ada di tipe Prisma 5.20 — panggil via cast.
    const on = this.$on as unknown as (
      event: string,
      cb: () => void,
    ) => void;
    on('beforeExit', () => {
      void app.close();
    });
  }
}
