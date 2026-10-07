import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Body untuk POST /customers/:id/isolate. */
export class IsolateCustomerDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

/** Body untuk POST /customers/:id/throttle. */
export class ThrottleCustomerDto {
  /** Batas download dalam Kbps. */
  @IsInt()
  @Min(64)
  downKbps!: number;

  /** Batas upload dalam Kbps. */
  @IsInt()
  @Min(64)
  upKbps!: number;
}
