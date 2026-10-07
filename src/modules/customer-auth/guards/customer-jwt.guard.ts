import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Guard autentikasi JWT khusus portal pelanggan.
 * Memakai strategi 'customer-jwt' yang menolak token non-CUSTOMER.
 */
@Injectable()
export class CustomerJwtGuard extends AuthGuard('customer-jwt') {}
