import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';

/** User aman untuk client — TANPA passwordHash. */
function toSafeUser(u: User) {
  const { passwordHash: _removed, ...rest } = u;
  void _removed;
  return rest;
}

const BCRYPT_ROUNDS = 10;

/**
 * Manajemen akun staf (admin, NOC, kasir, CS, teknisi, reseller).
 * Semua operasi di sini hanya untuk ADMIN.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const rows = await this.prisma.user.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toSafeUser);
  }

  async findOne(id: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User #${id} tidak ditemukan`);
    }
    return toSafeUser(user);
  }

  async create(dto: CreateUserDto) {
    const emailTaken = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (emailTaken) {
      throw new ConflictException(`Email "${dto.email}" sudah terdaftar`);
    }
    const created = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
        role: dto.role,
        resellerId: dto.resellerId ?? null,
      },
    });
    this.logger.log(`User staf "${created.email}" (${created.role}) dibuat`);
    return toSafeUser(created);
  }

  /**
   * Update nama / role / status aktif. Admin tidak boleh menonaktifkan
   * akunnya sendiri agar tidak terkunci keluar.
   */
  async update(id: number, dto: UpdateUserDto, actorId: number) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`User #${id} tidak ditemukan`);
    }
    if (id === actorId && dto.isActive === false) {
      throw new ForbiddenException('Anda tidak boleh menonaktifkan akun sendiri');
    }
    const data: Prisma.UserUpdateInput = {
      name: dto.name,
      role: dto.role,
      isActive: dto.isActive,
    };
    const cleanData = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined),
    ) as Prisma.UserUpdateInput;
    const updated = await this.prisma.user.update({ where: { id }, data: cleanData });
    this.logger.log(`User #${id} diperbarui oleh admin #${actorId}`);
    return toSafeUser(updated);
  }

  async resetPassword(id: number, newPassword: string) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`User #${id} tidak ditemukan`);
    }
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) },
    });
    this.logger.log(`Password user #${id} ("${existing.email}") direset oleh admin`);
    return { ok: true, message: `Password untuk "${existing.email}" berhasil direset` };
  }
}
