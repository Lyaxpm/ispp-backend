import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { CustomerAuthUser } from '../customer-auth.types';

/**
 * Ambil akun pelanggan terautentikasi dari request
 * (hasil CustomerJwtStrategy.validate()).
 */
export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CustomerAuthUser | undefined => {
    const request = ctx.switchToHttp().getRequest<{ user?: CustomerAuthUser }>();
    return request.user;
  },
);
