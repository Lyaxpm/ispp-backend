import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/** Body untuk POST /customer-auth/login. */
export class CustomerLoginDto {
  @IsEmail()
  @MaxLength(150)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  password!: string;
}

/** Body untuk POST /customer-auth/change-password. */
export class CustomerChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  oldPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(100)
  newPassword!: string;
}
