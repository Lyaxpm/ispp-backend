# Panduan Deploy ke Cloud — ISP Platform

## Arsitektur yang dipakai (jujur dulu)

Vercel itu **serverless** — cocok untuk frontend, tapi **tidak cocok** untuk
backend platform ini. Backend NestJS memakai BullMQ workers dan koneksi
persisten ke MikroTik/OLT yang harus jalan terus-menerus, dan itu tidak bisa
hidup di fungsi serverless. Jadi arsitekturnya dibagi:

| Komponen | Layanan | Alasan |
|---|---|---|
| Frontend (Next.js) | **Vercel** | Memang habitatnya, gratis, deploy otomatis dari GitHub |
| Backend (NestJS + workers) | **Railway** | Container jalan terus, `Dockerfile` sudah siap |
| Database PostgreSQL + PostGIS | **Supabase** | Postgres gratis + ekstensi PostGIS bawaan |
| Redis (BullMQ) | **Upstash** | Redis serverless gratis |

Perkiraan biaya: semuanya bisa jalan di **tier gratis** masing-masing layanan.

## Langkah 1 — Database di Supabase

1. Daftar/login di [supabase.com](https://supabase.com) → **New project**.
2. Buka **SQL Editor** → jalankan sekali:
   ```sql
   create extension if not exists postgis;
   ```
3. Buka **Project Settings → Database** → salin **Connection string**
   mode **Transaction** (port `6543`, untuk PgBouncer).
4. Tambahkan `?pgbouncer=true` di akhir URL. Hasilnya dipakai sebagai
   `DATABASE_URL`, contoh:
   ```
   postgresql://postgres.xxxxx:PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true
   ```

## Langkah 2 — Redis di Upstash

1. Daftar di [upstash.com](https://upstash.com) → **Create Database** (Redis).
2. Salin **Redis URL** (`rediss://...`) → dipakai sebagai `REDIS_URL`.

## Langkah 3 — Backend di Railway

1. Daftar di [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → pilih `LyaXpm/ispp-backend`.
2. Railway otomatis mendeteksi `Dockerfile` di root repo — tidak perlu setting Root Directory.
3. Buka **Variables**, isi minimal:
   ```
   DATABASE_URL=<URL Supabase dari Langkah 1>
   REDIS_URL=<URL Upstash dari Langkah 2>
   JWT_SECRET=<string acak minimal 32 karakter>
   CREDENTIALS_KEY=<64 karakter hex acak, mis. hasil: openssl rand -hex 32>
   CORS_ORIGIN=https://<url-vercel-kamu>   (diisi setelah Langkah 5)
   ```
   `PORT` tidak perlu diisi — Railway mengisinya otomatis dan backend
   sudah membaca `process.env.PORT`.
4. Deploy. `Dockerfile` otomatis menjalankan `prisma migrate deploy`
   saat container start, jadi 31 tabel langsung terbentuk.
5. Catat URL publik service-nya, mis. `https://ispp-backend.up.railway.app`.
   API ada di `https://ispp-backend.up.railway.app/api`.

### Kolom geometry PostGIS (sekali saja)

Karena kolom `geom` dideklarasikan `Unsupported` di Prisma, buat manual
di **Supabase SQL Editor** setelah migrate pertama — salin perintah
`ALTER TABLE` dari `backend/prisma/migrations/POSTGIS_NOTES.md`.

### Seed akun admin

Dari laptop/komputer kamu (folder `backend/` repo ini):

```bash
npm install
DATABASE_URL="<URL Supabase>" CREDENTIALS_KEY="<sama seperti di Railway>" \
  npx prisma db seed
```

Login dengan `admin@isp.local` / `admin123`, lalu segera ganti passwordnya.

## Langkah 4 — Frontend di Vercel

1. Daftar di [vercel.com](https://vercel.com) → **Add New → Project** →
   **Import** repo `LyaXpm/ispp-frontend`.
3. **Environment Variables**:
   ```
   NEXT_PUBLIC_API_URL=https://<url-railway-kamu>/api
   ```
4. **Deploy**. Dapat URL mis. `https://ispp.vercel.app`.

## Langkah 5 — Sambungkan CORS

Kembali ke Railway → variable `CORS_ORIGIN` isi dengan URL Vercel
(mis. `https://ispp.vercel.app`), lalu **Redeploy** backend.
Tanpa ini, browser memblokir request frontend → backend.

## Langkah 6 — Webhook payment gateway (opsional)

Di dashboard **Midtrans** (Settings → Notification URL) dan/atau
**Xendit** (Settings → Callback URL), isi:

```
https://<url-railway-kamu>/api/webhooks/midtrans
https://<url-railway-kamu>/api/webhooks/xendit
```

Pakai kredensial **sandbox** dulu sampai alurnya terbukti jalan.

## Catatan jujur / batasan

- **Supabase free tier**: project di-pause bila 7 hari tidak ada aktivitas —
  tinggal klik "Restore" bila terjadi.
- **IP publik dinamis**: Railway/Upstash memakai IP keluar yang berubah-ubah.
  Bila MikroTik/OLT kamu memfilter IP untuk API/SNMP, koneksi dari cloud
  bisa ditolak. Untuk produksi serius dengan perangkat on-premise, backend
  lebih cocok di **VPS dengan IP statis** (atau via VPN ke jaringan kamu).
- **WhatsApp gateway** tetap butuh service terpisah (mis. container Baileys
  di Railway/VPS) — isi `WA_GATEWAY_URL` bila sudah ada.
- **GenieACS** bisa dinyalakan sebagai service tambahan di Railway
  (pakai image `genieacs/genieacs`) bila butuh TR-069.
- Kode di repo ini sudah disesuaikan untuk cloud: baca `PORT` otomatis,
  `CORS_ORIGIN` via env, dan migrasi SQL awal sudah ikut ter-commit
  (`backend/prisma/migrations/20261007_init/migration.sql`).
