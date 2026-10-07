import { SetMetadata } from '@nestjs/common';
import { RoleName } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Batasi akses endpoint ke peran tertentu. Selalu pasang JwtAuthGuard
 * (atau guard global) bersama decorator ini.
 *
 * @example
 *   @UseGuards(JwtAuthGuard, RolesGuard)
 *   @Roles(RoleName.ADMIN, RoleName.NOC)
 *   @Get('routers')
 */
export const Roles = (...roles: RoleName[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
