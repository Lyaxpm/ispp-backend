import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NasRouter, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { DriverFactory } from '../../network/drivers/driver-factory';
import { decrypt, encrypt } from '../../common/utils/crypto.util';

import {
  CreateNasRouterDto,
  UpdateNasRouterDto,
} from './dto/nas-router.dto';

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  reachable?: boolean;
  error?: string;
}

function toNasRouterDto(nas: NasRouter) {
  const {
    passwordEncrypted: _removed,
    ...rest
  } = nas;

  void _removed;

  return rest;
}

const TEST_TIMEOUT_MS = 10_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `${label} melebihi batas ${ms / 1000} detik`,
        ),
      );
    }, ms);
  });

  return Promise.race([
    promise,
    timeoutPromise,
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

@Injectable()
export class NasService {
  private readonly logger = new Logger(NasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: DriverFactory,
  ) {}

  async findAll() {
    const rows = await this.prisma.nasRouter.findMany({
      orderBy: {
        name: 'asc',
      },
    });

    return rows.map(toNasRouterDto);
  }

  async findOne(id: number) {
    const nas = await this.prisma.nasRouter.findUnique({
      where: {
        id,
      },
    });

    if (!nas) {
      throw new NotFoundException(
        `NAS router #${id} tidak ditemukan`,
      );
    }

    return toNasRouterDto(nas);
  }

  async create(dto: CreateNasRouterDto) {
    await this.ensureNameUnique(dto.name);

    const created = await this.prisma.nasRouter.create({
      data: {
        name: dto.name,
        host: dto.host,
        apiPort: dto.apiPort ?? 8728,
        username: dto.username,

        passwordEncrypted: encrypt(
          dto.password,
        ),

        useTls: dto.useTls ?? false,
        type: dto.type ?? 'MIKROTIK',
        location: dto.location ?? null,
      },
    });

    this.logger.log(
      `NAS router "${created.name}" (${created.host}) ditambahkan`,
    );

    return toNasRouterDto(created);
  }

  async update(
    id: number,
    dto: UpdateNasRouterDto,
  ) {
    const existing =
      await this.prisma.nasRouter.findUnique({
        where: {
          id,
        },
      });

    if (!existing) {
      throw new NotFoundException(
        `NAS router #${id} tidak ditemukan`,
      );
    }

    if (
      dto.name &&
      dto.name !== existing.name
    ) {
      await this.ensureNameUnique(
        dto.name,
      );
    }

    const data: Prisma.NasRouterUpdateInput = {
      name: dto.name,
      host: dto.host,
      apiPort: dto.apiPort,
      username: dto.username,
      useTls: dto.useTls,
      type: dto.type,
      location: dto.location,
      isActive: dto.isActive,
    };

    if (dto.password) {
      data.passwordEncrypted = encrypt(
        dto.password,
      );
    }

    const cleanData = Object.fromEntries(
      Object.entries(data).filter(
        ([, value]) =>
          value !== undefined,
      ),
    ) as Prisma.NasRouterUpdateInput;

    const updated =
      await this.prisma.nasRouter.update({
        where: {
          id,
        },
        data: cleanData,
      });

    this.logger.log(
      `NAS router #${id} diperbarui`,
    );

    return toNasRouterDto(updated);
  }

  async remove(id: number) {
    const existing =
      await this.prisma.nasRouter.findUnique({
        where: {
          id,
        },

        include: {
          _count: {
            select: {
              customers: true,
            },
          },
        },
      });

    if (!existing) {
      throw new NotFoundException(
        `NAS router #${id} tidak ditemukan`,
      );
    }

    if (
      existing._count.customers > 0
    ) {
      throw new ConflictException(
        `NAS router "${existing.name}" masih dipakai ${existing._count.customers} pelanggan — nonaktifkan saja, jangan hapus`,
      );
    }

    await this.prisma.nasRouter.delete({
      where: {
        id,
      },
    });

    this.logger.log(
      `NAS router #${id} ("${existing.name}") dihapus`,
    );

    return {
      ok: true,
      message:
        `NAS router "${existing.name}" dihapus`,
    };
  }

  async testConnection(
    id: number,
  ): Promise<ConnectionTestResult> {
    const nas =
      await this.prisma.nasRouter.findUnique({
        where: {
          id,
        },
      });

    if (!nas) {
      return {
        ok: false,
        error:
          `NAS router #${id} tidak ditemukan`,
      };
    }

    let password: string;

    try {
      password = decrypt(
        nas.passwordEncrypted,
      );
    } catch (error) {
      this.logger.error(
        `Dekripsi password gagal untuk NAS "${nas.name}"`,
      );

      return {
        ok: false,
        error:
          'Gagal mendekripsi password router — periksa CREDENTIALS_KEY di environment',
      };
    }

    let driver;

    try {
      driver =
        this.factory.buildRouterDriver({
          host: nas.host,

          apiPort:
            nas.apiPort,

          username:
            nas.username,

          password,

          useTls:
            nas.useTls,

          type:
            nas.type,
        });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      return {
        ok: false,
        error: message,
      };
    }

    const startedAt =
      Date.now();

    try {
      await withTimeout(
        driver.connect(),
        TEST_TIMEOUT_MS,
        'Koneksi ke RouterOS API',
      );

      const resource =
        await withTimeout(
          driver.getSystemResource(),
          TEST_TIMEOUT_MS,
          'Uji RouterOS API',
        );

      const latencyMs =
        Date.now() -
        startedAt;

      this.logger.log(
        [
          `Uji koneksi NAS "${nas.name}" berhasil`,
          `host=${nas.host}:${nas.apiPort}`,
          `version=${resource.version}`,
          `uptime=${resource.uptime}`,
          `latency=${latencyMs}ms`,
        ].join(' | '),
      );

      return {
        ok: true,
        reachable: true,
        latencyMs,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      this.logger.warn(
        [
          `Uji koneksi NAS "${nas.name}" gagal`,
          `host=${nas.host}:${nas.apiPort}`,
          `error=${message}`,
        ].join(' | '),
      );

      return {
        ok: false,
        reachable: false,
        error:
          `Uji koneksi gagal: ${message}`,
      };
    } finally {
      await driver
        .disconnect()
        .catch(() => undefined);
    }
  }

  private async ensureNameUnique(
    name: string,
  ): Promise<void> {
    const existing =
      await this.prisma.nasRouter.findUnique({
        where: {
          name,
        },
      });

    if (existing) {
      throw new ConflictException(
        `Nama NAS router "${name}" sudah dipakai`,
      );
    }
  }
}
