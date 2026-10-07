import { Injectable } from '@nestjs/common';
import { InventoryCategory, InventoryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { buildMeta, paginate } from '../../common/utils/pagination.util';

export interface InventoryFilter {
  search?: string;
  category?: string;
  status?: string;
  page?: number;
  limit?: number;
}

/**
 * Stok gudang: router, ONU, fiber, splitter — dengan nomor seri/MAC.
 * Bentuk respons mengikuti kontrak frontend (id string, mac, condition).
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filter: InventoryFilter) {
    const { skip, take, page, limit } = paginate(filter.page, filter.limit);
    const where: Prisma.InventoryItemWhereInput = {};
    if (filter.search) {
      const q = filter.search.trim();
      where.OR = [
        { sku: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { serialNumber: { contains: q, mode: 'insensitive' } },
        { macAddress: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (filter.category) where.category = filter.category as InventoryCategory;
    if (filter.status) where.status = filter.status as InventoryStatus;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.inventoryItem.count({ where }),
      this.prisma.inventoryItem.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      data: rows.map((r) => ({
        id: String(r.id),
        sku: r.sku,
        name: r.name,
        category: r.category,
        serialNumber: r.serialNumber,
        mac: r.macAddress,
        quantity: r.quantity,
        warehouse: r.warehouse,
        condition: r.status,
      })),
      meta: buildMeta(total, page, limit),
    };
  }
}
