import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Package, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePackageDto, UpdatePackageDto } from './dto/package.dto';

/** Bentuk Package sesuai kontrak frontend (id string, kecepatan Mbps). */
export function toPackageDto(p: Package) {
  return {
    id: String(p.id),
    name: p.name,
    code: p.name,
    downloadMbps: p.downloadMbps,
    uploadMbps: p.uploadMbps,
    price: Number(p.price),
    validityDays: p.validityDays,
    fupGb: p.fupGb,
    serviceType: p.serviceType,
    billingType: p.billingType,
    installFee: Number(p.installFee),
    setupFee: Number(p.setupFee),
    description: p.description,
    mikrotikProfile: p.mikrotikProfile,
    radiusRateLimit: p.radiusRateLimit,
    isActive: p.isActive,
  };
}

/**
 * Katalog paket layanan — dipakai filter pelanggan & pembuatan langganan.
 */
@Injectable()
export class PackagesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllActive() {
    const rows = await this.prisma.package.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
    });
    return rows.map(toPackageDto);
  }

  async create(dto: CreatePackageDto) {
    await this.ensureNameUnique(dto.name);
    const created = await this.prisma.package.create({
      data: {
        name: dto.name,
        downloadMbps: dto.downloadMbps,
        uploadMbps: dto.uploadMbps,
        price: dto.price,
        validityDays: dto.validityDays ?? 30,
        fupGb: dto.fupGb ?? null,
        serviceType: dto.serviceType,
        billingType: dto.billingType,
        installFee: dto.installFee ?? 0,
        setupFee: dto.setupFee ?? 0,
        description: dto.description ?? null,
        mikrotikProfile: dto.mikrotikProfile ?? null,
        radiusRateLimit: dto.radiusRateLimit ?? null,
      },
    });
    return toPackageDto(created);
  }

  async update(id: number, dto: UpdatePackageDto) {
    const existing = await this.prisma.package.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Paket #${id} tidak ditemukan`);
    }
    if (dto.name && dto.name !== existing.name) {
      await this.ensureNameUnique(dto.name);
    }
    const cleanData = Object.fromEntries(
      Object.entries({ ...dto }).filter(([, v]) => v !== undefined),
    ) as Prisma.PackageUpdateInput;
    const updated = await this.prisma.package.update({ where: { id }, data: cleanData });
    return toPackageDto(updated);
  }

  /**
   * Soft delete — hanya set isActive=false. Paket tidak dihapus fisik
   * karena masih direferensikan pelanggan & langganan lama.
   */
  async softDelete(id: number) {
    const existing = await this.prisma.package.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Paket #${id} tidak ditemukan`);
    }
    const updated = await this.prisma.package.update({
      where: { id },
      data: { isActive: false },
    });
    return toPackageDto(updated);
  }

  private async ensureNameUnique(name: string): Promise<void> {
    const existing = await this.prisma.package.findUnique({ where: { name } });
    if (existing) {
      throw new ConflictException(`Nama paket "${name}" sudah dipakai`);
    }
  }
}
