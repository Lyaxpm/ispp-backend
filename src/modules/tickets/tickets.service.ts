import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { buildMeta, paginate } from '../../common/utils/pagination.util';
import { CreateTicketDto, TicketFilterDto, UpdateTicketDto } from './dto/ticket.dto';

type TicketRow = Prisma.TicketGetPayload<{
  include: { customer: true; assignedTo: true };
}>;

/** Frontend memakai CRITICAL; skema memakai URGENT. */
function toBackendPriority(p: string): TicketPriority {
  return p === 'CRITICAL' ? TicketPriority.URGENT : (p as TicketPriority);
}
function toFrontendPriority(p: TicketPriority): string {
  return p === TicketPriority.URGENT ? 'CRITICAL' : p;
}

export function toTicketDto(t: TicketRow) {
  return {
    id: String(t.id),
    ticketNo: t.number,
    subject: t.title,
    description: t.description,
    status: t.status,
    priority: toFrontendPriority(t.priority),
    customerId: t.customerId ? String(t.customerId) : null,
    customer: t.customer
      ? {
          id: String(t.customer.id),
          name: t.customer.name,
          customerNo: t.customer.customerNo,
        }
      : null,
    assignee: t.assignedTo ? t.assignedTo.name : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * Tiket insiden & work order: pelaporan, penugasan teknisi,
 * dan alur status OPEN → IN_PROGRESS → RESOLVED → CLOSED.
 */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(filter: TicketFilterDto) {
    const { skip, take, page, limit } = paginate(filter.page, filter.limit);
    const where: Prisma.TicketWhereInput = {};
    if (filter.status) where.status = filter.status as TicketStatus;
    if (filter.search) {
      const q = filter.search.trim();
      where.OR = [
        { number: { contains: q, mode: 'insensitive' } },
        { title: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: { customer: true, assignedTo: true },
      }),
    ]);
    return { data: rows.map(toTicketDto), meta: buildMeta(total, page, limit) };
  }

  async findOne(id: number) {
    const t = await this.prisma.ticket.findUnique({
      where: { id },
      include: { customer: true, assignedTo: true },
    });
    if (!t) throw new NotFoundException('Tiket tidak ditemukan');
    return toTicketDto(t);
  }

  /** Buat tiket baru dengan nomor TKT-YYYYMM-#### yang atomik. */
  async create(dto: CreateTicketDto, reportedById: number) {
    if (dto.customerId) {
      const c = await this.prisma.customer.findUnique({
        where: { id: dto.customerId },
        select: { id: true },
      });
      if (!c) throw new NotFoundException('Pelanggan tidak ditemukan');
    }
    const now = new Date();
    const prefix = `TKT-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const created = await this.prisma.$transaction(async (tx) => {
      const seqKey = `TICKET_SEQ_${prefix}`;
      const row = await tx.setting.findUnique({ where: { key: seqKey } });
      const next = Number(row?.value || '0') + 1;
      await tx.setting.upsert({
        where: { key: seqKey },
        create: { key: seqKey, value: String(next) },
        update: { value: String(next) },
      });
      const number = `${prefix}-${String(next).padStart(4, '0')}`;
      return tx.ticket.create({
        data: {
          number,
          customerId: dto.customerId ?? null,
          title: dto.title,
          description: dto.description,
          priority: toBackendPriority(dto.priority ?? 'MEDIUM'),
          status: TicketStatus.OPEN,
          reportedById,
        },
        include: { customer: true, assignedTo: true },
      });
    });
    this.logger.log(`Tiket ${created.number} dibuat oleh user ${reportedById}`);
    return toTicketDto(created);
  }

  async update(id: number, dto: UpdateTicketDto, actorId: number) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Tiket tidak ditemukan');

    if (dto.assignedToId) {
      const tech = await this.prisma.user.findUnique({
        where: { id: dto.assignedToId },
        select: { id: true },
      });
      if (!tech) throw new NotFoundException('Teknisi/pengguna tidak ditemukan');
    }

    const data: Prisma.TicketUpdateInput = {};
    if (dto.status) {
      data.status = dto.status as TicketStatus;
      if (dto.status === TicketStatus.RESOLVED || dto.status === TicketStatus.CLOSED) {
        data.resolvedAt = new Date();
      } else {
        data.resolvedAt = null;
      }
    }
    if (dto.priority) data.priority = toBackendPriority(dto.priority);
    if (dto.assignedToId !== undefined) {
      data.assignedTo = dto.assignedToId
        ? { connect: { id: dto.assignedToId } }
        : { disconnect: true };
      if (dto.assignedToId && t.status === TicketStatus.OPEN) {
        data.status = TicketStatus.IN_PROGRESS;
      }
    }

    const updated = await this.prisma.ticket.update({
      where: { id },
      data,
      include: { customer: true, assignedTo: true },
    });
    await this.prisma.auditLog.create({
      data: {
        action: 'ticket.update',
        entity: 'Ticket',
        entityId: String(id),
        actorId,
        customerId: updated.customerId ?? undefined,
        diff: { ...dto },
      },
    }).catch(() => undefined);
    return toTicketDto(updated);
  }
}
