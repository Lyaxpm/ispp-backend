import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Kategori tiket versi portal (dipetakan ke deskripsi bila backend tak punya kolom kategori). */
const PORTAL_TICKET_CATEGORIES = ['GANGGUAN', 'PEMBAYARAN', 'PEMASANGAN', 'LAINNYA'] as const;

/** Body untuk POST /portal/tickets. */
export class CreatePortalTicketDto {
  @IsString()
  @MinLength(5)
  @MaxLength(160)
  subject!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  message!: string;

  @IsOptional()
  @IsIn([...PORTAL_TICKET_CATEGORIES])
  category?: (typeof PORTAL_TICKET_CATEGORIES)[number];
}

/** Body untuk POST /portal/change-pppoe-password. */
export class ChangePppoePasswordDto {
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  newPassword!: string;
}
