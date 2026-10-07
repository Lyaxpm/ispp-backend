import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';

export class CreatePortalAccountDto {
  @IsEmail({}, { message: 'Email tidak valid' })
  email!: string;

  @IsNotEmpty({ message: 'Kata sandi wajib diisi' })
  @MinLength(8, { message: 'Kata sandi minimal 8 karakter' })
  password!: string;
}

export class ResetPortalPasswordDto {
  @IsNotEmpty({ message: 'Kata sandi baru wajib diisi' })
  @MinLength(8, { message: 'Kata sandi minimal 8 karakter' })
  newPassword!: string;
}
