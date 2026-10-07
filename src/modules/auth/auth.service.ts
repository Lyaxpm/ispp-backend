import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload, SafeUser } from './auth.types';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Verifikasi email + password. Mengembalikan user TANPA passwordHash,
   * atau null bila kredensial salah / akun nonaktif.
   */
  async validateUser(email: string, password: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      return null;
    }
    if (!user.isActive) {
      this.logger.warn(`Login ditolak: akun nonaktif (${email})`);
      return null;
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return null;
    }
    const { passwordHash: _removed, ...safe } = user;
    void _removed;
    return {
      id: safe.id,
      name: safe.name,
      email: safe.email,
      role: safe.role,
      resellerId: safe.resellerId,
      isActive: safe.isActive,
    };
  }

  /** Terbitkan pasangan access + refresh token untuk user yang valid. */
  login(user: SafeUser): TokenPair & { user: SafeUser } {
    const accessPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      type: 'access',
    };
    const refreshPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      type: 'refresh',
    };
    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN', '1d');
    const access_token = this.jwt.sign(accessPayload, { expiresIn });
    const refresh_token = this.jwt.sign(refreshPayload, { expiresIn: '7d' });
    return { access_token, refresh_token, token_type: 'Bearer', expires_in: expiresIn, user };
  }

  /**
   * Tukar refresh token yang masih berlaku dengan pasangan token baru.
   * Refresh token yang kedaluwarsa / bertipe salah ditolak.
   */
  async refresh(refreshToken: string): Promise<TokenPair & { user: SafeUser }> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('Refresh token tidak valid atau kedaluwarsa');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Token bukan refresh token');
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Akun tidak ditemukan atau nonaktif');
    }
    return this.login({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      resellerId: user.resellerId,
      isActive: user.isActive,
    });
  }
}
