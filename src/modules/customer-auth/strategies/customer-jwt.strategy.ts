import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { CustomerAuthUser, CustomerJwtPayload } from '../customer-auth.types';

/**
 * Strategi JWT khusus portal pelanggan ('customer-jwt').
 * Token staf (role ADMIN/NOC/dll) DITOLAK di sini — hanya role CUSTOMER
 * yang boleh lewat, sehingga guard portal tidak bisa dipakai token staf.
 */
@Injectable()
export class CustomerJwtStrategy extends PassportStrategy(Strategy, 'customer-jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: CustomerJwtPayload): CustomerAuthUser {
    if (payload.role !== 'CUSTOMER' || !payload.customerId) {
      throw new UnauthorizedException('Token bukan token akun pelanggan');
    }
    return {
      customerId: payload.customerId,
      email: payload.email,
      role: 'CUSTOMER',
    };
  }
}
