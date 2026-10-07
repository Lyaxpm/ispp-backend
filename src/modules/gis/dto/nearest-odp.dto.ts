import { IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class NearestOdpQueryDto {
  @Type(() => Number)
  @IsNumber({}, { message: 'lat harus berupa angka.' })
  @Min(-90, { message: 'lat minimal -90.' })
  @Max(90, { message: 'lat maksimal 90.' })
  lat!: number;

  @Type(() => Number)
  @IsNumber({}, { message: 'lng harus berupa angka.' })
  @Min(-180, { message: 'lng minimal -180.' })
  @Max(180, { message: 'lng maksimal 180.' })
  lng!: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber({}, { message: 'radius harus berupa angka.' })
  @Min(50, { message: 'radius minimal 50 meter.' })
  @Max(20000, { message: 'radius maksimal 20000 meter.' })
  radius?: number;
}
