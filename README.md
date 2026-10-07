# ISP Platform — Backend (NestJS)

> Repo ini berisi **backend** (API + workers). Frontend (dashboard Next.js)
> ada di repo terpisah: **LyaXpm/ispp-frontend**.

Platform full-stack production-grade untuk operasional ISP: billing & penagihan
otomatis, otomasi jaringan (MikroTik, RADIUS, OLT multi-vendor), manajemen
infrastruktur FTTH berbasis GIS (PostGIS), serta dashboard admin Next.js
dengan peta jaringan interaktif dan konsol NOC.

Bahasa pengantar UI & pesan pengguna: **Bahasa Indonesia**.

---

## 1. Arsitektur

```
ispp-backend/   # NestJS 10 + Prisma + PostgreSQL/PostGIS + Redis + BullMQ
├── prisma/
│   ├── schema.prisma          # 30 model, 29 enum, relasi penuh
│   ├── seed.ts                # admin, paket, setting, contoh NAS/OLT/ODP
│   └── migrations/
│       ├── 20261007_init/migration.sql  # migrasi awal (31 tabel)
│       └── POSTGIS_NOTES.md   # SQL kolom geometry PostGIS (jalankan manual)
├── src/
│   ├── main.ts                # bootstrap: raw-body webhooks, helmet, Swagger /api/docs
│   ├── app.module.ts          # wiring seluruh modul fitur
│   ├── common/                # filter, pagination, crypto AES-GCM, billing-math
│   ├── config/                # konfigurasi typed dari env (baca PORT otomatis)
│   ├── prisma/                # PrismaService (global)
│   ├── services/
│   │   ├── billing-automation.service.ts  # webhook Midtrans/Xendit, settlement,
│   │   │                                  # generate invoice, denda, evaluasi tunggakan
│   │   └── gis-ftth.service.ts            # nearest-ODP PostGIS, coverage,
│   │                                      # calculateOutageImpact, topologi, GeoJSON
│   ├── network/
│   │   ├── drivers/           # NetworkDriver interface + driver produksi:
│   │   │                      #   mikrotik (node-routeros), huawei/zte/fiberhome/hsgq OLT
│   │   ├── services/          # NetworkOrchestratorService (isolir/aktif/throttle),
│   │   │                      # RadiusCoAService (RFC 5176 Disconnect-Request)
│   │   └── noc.controller.ts  # GET /network/noc/customers (konsol NOC)
│   ├── workers/               # BullMQ: isolation, invoice-generation,
│   │                          # optical-monitoring + workers.module.ts (bootstrap)
│   └── modules/
│       ├── auth/              # JWT + RBAC (ADMIN, NOC, CASHIER, TECHNICIAN, CS, RESELLER)
│       ├── audit/             # audit log otomatis untuk mutasi
│       ├── customers/         # CRUD + aksi NOC (isolate/unisolate/throttle/kick/reboot-onu)
│       ├── packages/          # katalog paket
│       ├── billing/           # invoice (prorata, PPN, denda, voucher)
│       ├── payments/          # Midtrans Snap, Xendit, manual/tunai, bukti TF, rekonsiliasi
│       ├── notifications/     # WhatsApp gateway + Telegram NOC
│       ├── radius/            # sinkronisasi radcheck/radreply FreeRADIUS
│       ├── gis/               # endpoint spasial + CRUD ODP/ODC
│       ├── olt/               # provisioning ONU, zero-touch swap, CRUD OLT/PON/ODP
│       ├── ipam/              # pool CIDR, alokasi IP, VLAN, static lease
│       ├── tr069/             # adapter GenieACS (WiFi, PPPoE WAN, reboot, firmware)
│       ├── dashboard/         # statistik & grafik pendapatan
│       ├── tickets/           # tiket insiden
│       └── inventory/         # stok gudang
├── Dockerfile                 # dipakai Railway (otomatis prisma migrate deploy)
├── docker-compose.yml         # postgres+postgis, redis, backend, freeradius (dev lokal)
├── DEPLOY.md                  # panduan deploy cloud (Railway + Supabase + Upstash)
└── PANDUAN_TEST.md            # cara testing lokal
```

---

## 2. Mulai Cepat (Backend)

```bash
cp .env.example .env
# isi: DATABASE_URL, REDIS_URL, JWT_SECRET, CREDENTIALS_KEY (wajib sebelum seed),
#      MIDTRANS_*, XENDIT_*, WA_GATEWAY_*, TELEGRAM_*, GENIEACS_*

docker compose up -d postgres redis        # atau pakai postgres/redis sendiri
npx prisma migrate dev                     # buat skema
# --- PostGIS (sekali saja) ---
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
# lalu jalankan ALTER TABLE ... ADD COLUMN geom ... dari prisma/migrations/POSTGIS_NOTES.md
npx prisma generate
npm run prisma:seed                        # admin@isp.local / admin123
npm run start:dev                          # http://localhost:3000/api, docs: /api/docs
```

> `CREDENTIALS_KEY` (32 karakter / 64 hex) **wajib** di-set sebelum seed &
> sebelum menyimpan kredensial perangkat — dipakai enkripsi AES-256-GCM
> untuk password MikroTik/OLT di database.

### Variabel env penting

| Key | Contoh | Keterangan |
|---|---|---|
| `DATABASE_URL` | `postgresql://isp:isp@localhost:5432/isp` | Postgres + PostGIS |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ |
| `JWT_SECRET` | acak 32+ char | — |
| `CREDENTIALS_KEY` | 64 hex | enkripsi kredensial perangkat |
| `PPN_RATE` | `11` | persen PPN invoice |
| `GRACE_PERIOD_DAYS` | `3` | masa tenggang sebelum denda |
| `ISOLATION_TIER1_DAYS` / `TIER2_DAYS` | `3` / `7` | throttle lalu isolir penuh |
| `MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION` | — | payment gateway |
| `XENDIT_SECRET_KEY`, `XENDIT_CALLBACK_TOKEN` | — | payment gateway |
| `WA_GATEWAY_URL`, `WA_GATEWAY_API_KEY` | — | gateway WhatsApp (kompatibel Baileys-HTTP) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_NOC_CHAT_ID` | — | alarm NOC |
| `GENIEACS_URL`, `GENIEACS_USERNAME/PASSWORD` | — | TR-069 |
| `WORKERS_ENABLED` | `true` | `false` bila worker jalan terpisah |

---

## 3. Alur Uang & Otomasi Jaringan

1. **Invoice** — worker `billing` (cron tiap tgl 1, 00:30) generate invoice
   bulanan: prorata bulan pertama, PPN, biaya admin, voucher. Idempoten via
   unique `(customerId, periodStart, periodEnd)`.
2. **Bayar** — Midtrans Snap / Xendit Invoice / QRIS / VA / tunai / transfer
   manual (upload bukti → konfirmasi kasir).
3. **Webhook** — `POST /api/webhooks/midtrans` (verifikasi HMAC-SHA512
   `order_id+status_code+gross_amount+serverKey`, raw body) dan
   `POST /api/webhooks/xendit` (token callback). Settlement dalam transaksi
   Prisma: invoice → PAID/PARTIAL, kelebihan → saldo pelanggan.
4. **Auto-aktivasi** — setelah lunas: pelanggan ISOLATED → `unisolateCustomer`
   (hapus dari address-list, tendang sesi) + `radiusSync.syncCustomer` +
   struk WhatsApp. Kegagalan jaringan **tidak** me-rollback pembayaran.
5. **Isolasi bertingkat** — worker `network-ops` (cron tiap hari 02:00):
   - H+`TIER1_DAYS` tunggakan → throttle 512/512 + WA peringatan
   - H+`TIER2_DAYS` → isolir penuh: address-list `ISOLATED` + NAT dstnat
     80/443 → portal pembayaran + kick sesi PPPoE + flag RADIUS
     `Mikrotik-Address-List`, lalu WA pemberitahuan isolir.
   - Denda keterlambatan (persen/flat, sekali per invoice) via cron 01:00.

---

## 4. Jaringan: MikroTik, RADIUS, OLT

### MikroTik (`src/network/drivers/mikrotik.driver.ts`)
`node-routeros` dengan auto-reconnect: PPPoE secret/profile, address-list,
NAT redirect portal, `/ppp/active/remove` (kick), simple queue + builder
format rate-limit RouterOS (`rx/tx burst thr 8/8`), ping, resource.
Semua tulis diserialisasi per-host (mutex promise-chain) dan idempoten
(print → set/add).

### FreeRADIUS (`src/modules/radius/`)
`radcheck`: `Cleartext-Password`, `Simultaneous-Use := 1`,
`Session-Timeout`, `Expiration`. `radreply`: `Mikrotik-Rate-Limit` (dari
paket + burst), `Framed-IP-Address` (dari alokasi IPAM), dan
`Mikrotik-Address-List := ISOLATED` saat pelanggan diisolir — isolasi
ditegakkan juga saat login ulang. CoA: `RadiusCoAService` membangun paket
Disconnect-Request (RFC 5176) via UDP/3799 dengan verifikasi MD5
ResponseAuthenticator.

Password PPPoE diambil dari Setting `PPPOE_PASSWORD_<customerNo>`,
fallback `PPPOE_DEFAULT_PASSWORD`. (Rekomendasi produksi: tambah kolom
`pppoePassword` terenkripsi di `Customer`.)

### OLT multi-vendor (`src/network/drivers/`)
| Vendor | Transport | Cakupan |
|---|---|---|
| Huawei MA5600T/5800 | SNMP (net-snmp) + SSH (ssh2) | discovery ONT, registrasi, VLAN, speed-cap, daya optik |
| ZTE C320/C300 | SNMP + SSH | idem |
| FiberHome AN5516 | Telnet utama, SSH fallback | idem (CLI) |
| HSGQ | Telnet/SSH | SN GPON 16-hex / MAC EPON |

`DriverFactory` me-cache driver per perangkat (lazy connect + health probe).
Provisioning: `OltService.provisionOnu` (SN → ontId → VLAN → speed-cap dari
paket → simpan ONU). **Zero-touch swap** (`replaceOnuZeroTouch`):
deregister SN lama → register SN baru di PON port & ontId yang sama dengan
profil/VLAN/kecepatan yang sama (disimpan sebagai JSON di kolom
`Onu.firmware` — lihat komentar di kode).

### Monitoring optik
Worker `monitoring` (tiap 15 menit): baca RX/TX per ONU via SNMP,
klasifikasi DEGRADED (< −27 dBm) & LOS, alarm Telegram langsung untuk LOS
(throttle 1 jam untuk DEGRADED), **deteksi mass-LOS** (≥30% ONU satu PON
port LOS dalam 10 menit) → `calculateOutageImpact` + WA massal (throttle
30 menit per node).

### TR-069 (`src/modules/tr069/`)
Adapter GenieACS NBI: set SSID/password WiFi, kredensial PPPoE WAN, reboot,
factory reset, push firmware massal (konkurensi 5), baca statistik optik.

---

## 5. GIS & FTTH (`src/services/gis-ftth.service.ts`)

- `findNearestOdp(lat, lng, radius)` — PostGIS `ST_DWithin`/`ST_Distance`
  dengan fallback haversine bila kolom `geom` belum ada.
- `checkCoverage` — self-check cakupan untuk registrasi online.
- `assignCustomerToOdpPort` — `SELECT ... FOR UPDATE`, validasi kapasitas,
  anti double-booking; `releaseOdpPort` untuk terminasi/relokasi.
- `calculateOutageImpact('OLT'|'PON_PORT'|'ODC'|'ODP', id)` — telusuri
  hierarki → daftar pelanggan terdampak (nama, telepon, kode ODP) +
  `notifyOutageAlert` WA massal.
- `getTopologyTree(oltId)` — JSON OLT → PON → ODC/ODP → port → pelanggan
  untuk visualizer; `exportGeoJSON(layer)` untuk Leaflet.

Endpoint: `GET /api/gis/nearest-odp|coverage|topology/:oltId|geojson/:layer`,
`POST /api/gis/outage-impact`, assign/release ODP port, CRUD ODP/ODC/OLT.

---

## 6. Frontend

Dashboard admin (Next.js 14 + Tailwind + Leaflet + Recharts) hidup di repo
terpisah: **[LyaXpm/ispp-frontend](https://github.com/LyaXpm/ispp-frontend)**
— deploy ke Vercel, arahkan `NEXT_PUBLIC_API_URL` ke URL backend ini
(mis. `https://ispp-backend.up.railway.app/api`).

## 7. Batasan & catatan jujur

- **Belum diuji end-to-end**: tidak ada perangkat MikroTik/OLT fisik,
  gateway Midtrans/Xendit, maupun WA gateway di lingkungan build — logika
  protokol ditulis penuh dan di-review statis, tapi kalibrasi pertama
  (OID SNMP ZTE, verb CLI FiberHome/HSGQ per firmware) harus dilakukan
  saat deployment. Lihat komentar `TODO(firmware)` di driver.
- Aset privat/restricted Roblox tidak relevan di sini; untuk **aset ISP**:
  IP publik/CGNAT hanya bermakna bila pool-nya memang di-routing.
- Notifikasi WhatsApp butuh gateway HTTP sendiri (`WA_GATEWAY_URL`);
  tanpa itu, pengiriman dicatat FAILED di `notification_log` dan tidak
  melempar error ke alur bisnis.
- FreeRADIUS container di `docker-compose.yml` perlu di-mount dengan
  `sql.conf` yang menunjuk ke database ini (lihat komentar di file).

---

## 8. Peta prioritas (dari spesifikasi)

- **MVP** ✅ — pelanggan & lifecycle, paket, invoice+PPN+prorata+denda,
  Midtrans/Xendit webhook, transfer manual/tunai, auto-isolir/aktivasi,
  MikroTik + RADIUS, IPAM dasar, GIS OLT→ODP→pelanggan, WA engine, RBAC,
  audit log, worker backup DB (jadwalkan via cron OS: `pg_dump`).
- **P2** sebagian ✅ — tiket, inventaris, voucher, nearest-ODP, impact
  engine, driver OLT 4 vendor, monitoring optik, TR-069. Belum: portal
  pelanggan, import/export CSV, hotspot/VPN, add-on IPTV/VoIP, rekonsiliasi
  bank otomatis penuh (ada pencocokan referensi manual), komisi reseller.
- **P3** belum — registrasi online self-coverage penuh, QinQ, driver
  Cisco/Huawei/Juniper/VyOS, Zabbix/Grafana adapter, turbo malam hari,
  SLA korporat, perencana rute teknisi.
