import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RoleName } from '@prisma/client';

const ROLES = Object.values(RoleName);

/** Body untuk POST /users. */
export class CreateUserDto {
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name!: string;

  @IsEmail()
  @MaxLength(150)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(100)
  password!: string;

  @IsIn([...ROLES])
  role!: RoleName;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  resellerId?: number;
}

/** Body untuk PATCH /users/:id. */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsIn([...ROLES])
  role?: RoleName;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Body untuk POST /users/:id/reset-password. */
export class ResetPasswordDto {
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  newPassword!: string;
}
