import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerJwtPayload } from './customer-auth.types';

const BCRYPT_ROUNDS = 10;

/** Akun pelanggan aman untuk client — TANPA passwordHash. */
function toSafeAccount(account: {
  id: number;
  customerId: number;
  email: string;
  isActive: boolean;
  lastLoginAt: Date | null;
}) {
  return account;
}

/**
 * Autentikasi akun portal pelanggan (CustomerAccount) — terpisah dari
 * login staf. Token yang diterbitkan ber-role CUSTOMER.
 */
@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Login pelanggan: verifikasi email + password, terbitkan JWT.
   * Melempar 401 bila kredensial salah atau akun nonaktif.
   */
  async login(email: string, password: string) {
    const account = await this.prisma.customerAccount.findUnique({
      where: { email },
      include: { customer: true },
    });
    if (!account) {
      throw new UnauthorizedException('Email atau password salah');
    }
    if (!account.isActive) {
      this.logger.warn(`Login portal ditolak: akun nonaktif (${email})`);
      throw new UnauthorizedException('Akun pelanggan nonaktif — hubungi CS kami');
    }
    const match = await bcrypt.compare(password, account.passwordHash);
    if (!match) {
      throw new UnauthorizedException('Email atau password salah');
    }
    await this.prisma.customerAccount.update({
      where: { id: account.id },
      data: { lastLoginAt: new Date() },
    });

    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN', '1d');
    const payload: CustomerJwtPayload = {
      sub: `customer:${account.id}`,
      role: 'CUSTOMER',
      customerId: account.customerId,
      email: account.email,
      type: 'access',
    };
    const access_token = await this.jwt.signAsync(payload);

    return {
      access_token,
      token_type: 'Bearer' as const,
      expires_in: expiresIn,
      customer: {
        id: account.customer.id,
        customerNo: account.customer.customerNo,
        name: account.customer.name,
      },
    };
  }

  /** Data akun + profil pelanggan yang sedang login. */
  async me(customerId: number) {
    const account = await this.prisma.customerAccount.findFirst({
      where: { customerId, isActive: true },
      include: { customer: true },
    });
    if (!account) {
      throw new UnauthorizedException('Akun pelanggan tidak ditemukan');
    }
    return {
      account: toSafeAccount({
        id: account.id,
        customerId: account.customerId,
        email: account.email,
        isActive: account.isActive,
        lastLoginAt: account.lastLoginAt,
      }),
      customer: account.customer,
    };
  }

  /** Ganti password akun portal — password lama harus cocok. */
  async changePassword(customerId: number, oldPassword: string, newPassword: string) {
    const account = await this.prisma.customerAccount.findFirst({
      where: { customerId, isActive: true },
    });
    if (!account) {
      throw new UnauthorizedException('Akun pelanggan tidak ditemukan');
    }
    const match = await bcrypt.compare(oldPassword, account.passwordHash);
    if (!match) {
      throw new BadRequestException('Password lama salah');
    }
    await this.prisma.customerAccount.update({
      where: { id: account.id },
      data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) },
    });
    this.logger.log(`Password portal pelanggan (customer #${customerId}) diganti`);
    return { ok: true, message: 'Password berhasil diganti' };
  }
}
