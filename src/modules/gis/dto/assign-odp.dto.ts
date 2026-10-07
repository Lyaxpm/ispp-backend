import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class AssignOdpDto {
  @Type(() => Number)
  @IsInt({ message: 'odpId harus berupa integer.' })
  @Min(1, { message: 'odpId minimal 1.' })
  odpId!: number;
}
