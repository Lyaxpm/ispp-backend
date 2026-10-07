import { registerAs } from '@nestjs/config';

export interface JwtConfig {
  secret: string;
  expiresIn: string;
  refreshExpiresIn: string;
}

export interface AppConfig {
  port: number;
  corsOrigins: string[];
  databaseUrl: string;
  redisUrl: string;
  jwt: JwtConfig;
  credentialsKey: string;
  midtrans: { serverKey: string; clientKey: string; isProduction: boolean };
  xendit: { secretKey: string; callbackToken: string };
  whatsapp: { gatewayUrl: string; apiKey: string };
  telegram: { botToken: string; nocChatId: string };
  genieacs: { url: string; username: string; password: string };
  billing: {
    ppnRate: number;
    gracePeriodDays: number;
    isolationTier1Days: number;
    isolationTier2Days: number;
  };
}

function toNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export default registerAs(
  'app',
  (): AppConfig => ({
    port: toNumber(process.env.APP_PORT, 3000),
    corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:3001')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    jwt: {
      secret: process.env.JWT_SECRET ?? 'change-me-in-production',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
      refreshExpiresIn: '7d',
    },
    credentialsKey: process.env.CREDENTIALS_KEY ?? '',
    midtrans: {
      serverKey: process.env.MIDTRANS_SERVER_KEY ?? '',
      clientKey: process.env.MIDTRANS_CLIENT_KEY ?? '',
      isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    },
    xendit: {
      secretKey: process.env.XENDIT_SECRET_KEY ?? '',
      callbackToken: process.env.XENDIT_CALLBACK_TOKEN ?? '',
    },
    whatsapp: {
      gatewayUrl: process.env.WA_GATEWAY_URL ?? 'http://localhost:3002',
      apiKey: process.env.WA_GATEWAY_API_KEY ?? '',
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      nocChatId: process.env.TELEGRAM_NOC_CHAT_ID ?? '',
    },
    genieacs: {
      url: process.env.GENIEACS_URL ?? 'http://localhost:7557',
      username: process.env.GENIEACS_USERNAME ?? '',
      password: process.env.GENIEACS_PASSWORD ?? '',
    },
    billing: {
      ppnRate: toNumber(process.env.PPN_RATE, 11),
      gracePeriodDays: toNumber(process.env.GRACE_PERIOD_DAYS, 3),
      isolationTier1Days: toNumber(process.env.ISOLATION_TIER1_DAYS, 7),
      isolationTier2Days: toNumber(process.env.ISOLATION_TIER2_DAYS, 14),
    },
  }),
);
