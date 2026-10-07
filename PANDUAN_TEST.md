# Panduan Testing — ISP Platform

Panduan ini menjelaskan cara menjalankan dan mengetes platform di mesin lokal
(Linux / macOS / Windows + WSL2). Semua perintah dijalankan dari folder repo ini.

## 1. Yang dibutuhkan

| Kebutuhan | Versi minimal | Cek |
|---|---|---|
| Docker + Docker Compose | 24+ | `docker --version` |
| Node.js | 20 LTS | `node --version` |
| Git | 2.40+ | `git --version` |

Tidak perlu install PostgreSQL/Redis manual — keduanya jalan via Docker.

## 2. Menyalakan database & Redis

```bash
docker compose up -d postgres redis
docker compose ps          # pastikan keduanya "healthy"
```

## 3. Menyiapkan backend

```bash
npm install
cp .env.example .env
```

Edit `.env`, minimal isi 3 nilai ini:

```env
DATABASE_URL=<redacted>
JWT_SECRET=ganti-dengan-string-acak-minimal-32-karakter
CREDENTIALS_KEY=<hex-64-karakter-acak>   # contoh: hasil `openssl rand -hex 32`
```

`CREDENTIALS_KEY` dipakai untuk mengenkripsi password perangkat (MikroTik/OLT)
di database. **Jangan pernah commit file `.env` ke Git.**

Lalu migrasi + seed data contoh:

```bash
npx prisma migrate dev --name init
npx prisma db seed
```

Seed membuat akun admin default (lihat output seed / `prisma/seed.ts`):

- email: `admin@isp.local`
- password: `admin123`

Jalankan backend:

```bash
npm run start:dev
# API: http://localhost:3000/api
# Swagger: http://localhost:3000/api/docs
```

## 4. Menyiapkan frontend

Frontend ada di repo terpisah **LyaXpm/ispp-frontend**:

```bash
git clone https://github.com/LyaXpm/ispp-frontend.git
cd ispp-frontend
npm install
cp .env.example .env.local   # isi NEXT_PUBLIC_API_URL=http://localhost:3000/api
npm run dev
# UI: http://localhost:3001 (atau port yang ditampilkan)
```

Login dengan akun admin dari langkah 3.

## 5. Alur test yang disarankan

### A. Billing end-to-end (tanpa payment gateway asli)
1. Buka menu **Pelanggan** → tambah pelanggan baru + pilih paket.
2. Buka menu **Billing** → buat invoice untuk pelanggan tersebut.
3. Catat pembayaran manual (tunai/transfer): `POST /api/billing/invoices/:id/payments`
   atau lewat UI. Cek status invoice berubah jadi `PAID` dan saldo pelanggan
   ter-update.
4. Test isolasi otomatis: buat invoice yang sudah jatuh tempo (`dueDate`
   kemarin), jalankan worker penalty/isolation — atau panggil endpoint
   `POST /api/network/customers/:id/isolate` dan lihat status pelanggan.

### B. Payment gateway (butuh akun sandbox)
- **Midtrans**: daftar di dashboard.midtrans.com → ambil Server Key (Sandbox) →
  isi `MIDTRANS_SERVER_KEY` di `.env`. Buat invoice → dapat Snap token →
  bayar pakai kartu test → webhook otomatis memverifikasi & melunasi invoice.
- **Xendit**: sama, pakai `XENDIT_CALLBACK_TOKEN` (Development).

### C. Network automation (butuh perangkat / bisa skip)
- **MikroTik**: isi data router di menu Settings → Network Devices, lalu test
  `POST /api/network/customers/:id/kick-session`. Tanpa router fisik, endpoint
  akan mengembalikan error koneksi — itu normal dan aman.
- **FreeRADIUS**: `docker compose up -d freeradius`, lalu ikuti komentar di
  `docker-compose.yml` untuk mengaktifkan modul SQL.
- **OLT (Huawei/ZTE/FiberHome/HSGQ)**: butuh akses SNMP/SSH ke OLT asli.
- **GenieACS**: uncomment service `genieacs` di `docker-compose.yml` bila mau
  test TR-069.

### D. GIS / FTTH
1. Buka menu **GIS** → peta Leaflet tampil dengan layer OLT/ODC/ODP.
2. Tambah OLT + ODC + ODP lewat API/seed, klik tool "nearest ODP" lalu klik
   lokasi pelanggan untuk test pencarian ODP terdekat.
3. Test outage impact: `GET /api/gis/outage-impact?nodeType=ODP&nodeId=1`.

## 6. Test otomatis (tanpa perangkat)

```bash
cd backend
npx tsc --noEmit        # typecheck
npx nest build          # build production
cd ~/workspace/isp-frontend  # repo terpisah
npx tsc --noEmit        # typecheck frontend
npm run build           # production build Next.js
```

## 7. Catatan jujur

- Fitur yang **sudah bisa dites penuh tanpa hardware**: auth, CRUD pelanggan,
  invoice, pembayaran manual, denda, reminder WA (butuh gateway), dashboard,
  tiket, inventory, GIS dasar, IPAM.
- Fitur yang **butuh perangkat/jasa asli**: MikroTik (PPPoE/isolasi),
  OLT (provisioning ONU), FreeRADIUS live, GenieACS, Midtrans/Xendit production,
  WhatsApp gateway. Kode driver-nya lengkap, tapi belum pernah dites melawan
  perangkat fisik.
- Password `isp_secret` di `docker-compose.yml` hanya default untuk dev lokal —
  ganti sebelum dipakai di server sungguhan.
