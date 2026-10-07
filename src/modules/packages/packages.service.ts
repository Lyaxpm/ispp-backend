import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Katalog paket layanan — dipakai filter pelanggan & pembuatan langganan.
 * Bentuk respons mengikuti kontrak frontend (id string, kecepatan Kbps).
 */
@Injectable()
export class PackagesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllActive() {
    const rows = await this.prisma.package.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
    });
    return rows.map((p) => ({
      id: String(p.id),
      name: p.name,
      code: p.name,
      downloadKbps: p.downloadMbps * 1000,
      uploadKbps: p.uploadMbps * 1000,
      price: Number(p.price),
      validityDays: p.validityDays,
      serviceType: p.serviceType,
      billingType: p.billingType,
      isActive: p.isActive,
    }));
  }
}
