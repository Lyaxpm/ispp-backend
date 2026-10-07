import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshDto {
  @ApiProperty({ description: 'Refresh token yang diterima saat login' })
  @IsString({ message: 'Refresh token harus berupa teks' })
  @MinLength(10, { message: 'Refresh token tidak valid' })
  refresh_token!: string;
}
