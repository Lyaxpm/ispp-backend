import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import { json, raw } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // ── Webhook raw-body parsers ──────────────────────────────────────────
  // WAJIB didaftarkan SEBELUM json parser agar verifikasi HMAC (Midtrans /
  // Xendit) menerima payload mentah yang belum tersentuh. body-parser akan
  // melewati request yang body-nya sudah dibaca (req._body ter-set oleh raw).
  // Dua varian path didaftarkan karena global prefix 'api' membuat controller
  // 'webhooks' ter-mapping ke /api/webhooks/...
  const webhookPaths = [
    '/webhooks/midtrans',
    '/webhooks/xendit',
    '/api/webhooks/midtrans',
    '/api/webhooks/xendit',
  ];
  for (const path of webhookPaths) {
    app.use(path, raw({ type: '*/*', limit: '1mb' }));
  }
  // JSON parser untuk semua route lain.
  app.use(json({ limit: '2mb' }));

  // ── Security & performance ────────────────────────────────────────────
  app.use(helmet());
  app.use(compression());

  const corsOrigin = config.get<string>('CORS_ORIGIN', 'http://localhost:3001');
  app.enableCors({
    origin: corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  });

  app.setGlobalPrefix('api');

  // ── Global pipes / filters / interceptors ─────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  // Catatan: TransformInterceptor TIDAK dipasang global — frontend
  // mengharapkan body respons mentah (controller sudah mengembalikan
  // bentuk {data, meta} untuk daftar berpaginasi).
  app.useGlobalFilters(new HttpExceptionFilter());

  // ── Swagger ───────────────────────────────────────────────────────────
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('ISP Platform API')
      .setDescription('ISP Billing, Network Automation & FTTH Infrastructure Management Platform')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document); // → /api/docs (karena global prefix)

  // ── Graceful shutdown ─────────────────────────────────────────────────
  app.enableShutdownHooks();

  const port = config.get<number>('APP_PORT', 3000);
  await app.listen(port, '0.0.0.0');
  logger.log(`Backend berjalan di http://0.0.0.0:${port}/api — docs: /api/docs`);
}

void bootstrap();
