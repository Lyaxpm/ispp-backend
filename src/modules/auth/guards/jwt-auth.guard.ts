import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Guard autentikasi JWT — pakai bersama @Roles() untuk otorisasi. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
