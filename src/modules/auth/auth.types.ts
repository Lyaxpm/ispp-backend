import { RoleName } from '@prisma/client';

/** Payload yang disimpan di dalam JWT access token. */
export interface JwtPayload {
  sub: number;
  email: string;
  role: RoleName;
  type?: 'access' | 'refresh';
}

/** Bentuk req.user setelah JwtStrategy.validate(). */
export interface AuthUser {
  userId: number;
  email: string;
  role: RoleName;
}

/** User aman untuk dikembalikan ke client (tanpa passwordHash). */
export interface SafeUser {
  id: number;
  name: string;
  email: string;
  role: RoleName;
  resellerId: number | null;
  isActive: boolean;
}
