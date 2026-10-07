/**
 * Tipe khusus autentikasi portal pelanggan — terpisah dari JWT staf
 * agar login admin dan login pelanggan tidak tercampur.
 */

/** Payload JWT untuk akun pelanggan. */
export interface CustomerJwtPayload {
  sub: string; // format: `customer:<id>`
  role: 'CUSTOMER';
  customerId: number;
  email: string;
  type?: 'access' | 'refresh';
}

/** Bentuk req.user setelah CustomerJwtStrategy.validate(). */
export interface CustomerAuthUser {
  customerId: number;
  email: string;
  role: 'CUSTOMER';
}
