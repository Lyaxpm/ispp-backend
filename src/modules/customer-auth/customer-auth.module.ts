import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { CustomerAuthController } from './customer-auth.controller';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerJwtStrategy } from './strategies/customer-jwt.strategy';
import { CustomerJwtGuard } from './guards/customer-jwt.guard';

@Module({
  imports: [
    // Registrasi JwtModule sendiri (secret sama dengan modul auth staf)
    // agar CustomerAuthService bisa menandatangani token pelanggan.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '1d') },
      }),
    }),
  ],
  controllers: [CustomerAuthController],
  providers: [CustomerAuthService, CustomerJwtStrategy, CustomerJwtGuard],
  exports: [CustomerAuthService, CustomerJwtGuard],
})
export class CustomerAuthModule {}
