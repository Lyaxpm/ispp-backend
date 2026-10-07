# PostGIS — Manual DDL Notes

Skema Prisma memakai `Unsupported("geometry(...)")` untuk kolom spasial. Prisma
**tidak** membuat / memigrasi kolom `Unsupported` — kolomnya harus dibuat
manual dengan SQL di bawah. Urutan yang benar:

## 1. Aktifkan ekstensi (sekali per database)

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

Jalankan ini **sebelum** `prisma migrate dev` pertama, atau kapan pun sebelum
statement ALTER TABLE di bawah. Cek dengan:

```sql
SELECT postgis_version();
```

## 2. Buat kolom geometry (setelah migrate)

```sql
-- Titik pelanggan
ALTER TABLE "Customer"    ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326);

-- Titik infrastruktur FTTH
ALTER TABLE "Olt"         ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326);
ALTER TABLE "Odc"         ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326);
ALTER TABLE "Odp"         ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326);

-- Rute kabel fiber (polyline)
ALTER TABLE "FiberCable"  ADD COLUMN IF NOT EXISTS route_geom geometry(LineString, 4326);
```

## 3. Index spasial (GIST) — wajib untuk query jarak yang cepat

```sql
CREATE INDEX IF NOT EXISTS idx_customer_geom ON "Customer"   USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_olt_geom      ON "Olt"        USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_odc_geom      ON "Odc"        USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_odp_geom      ON "Odp"        USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_fibercable_route ON "FiberCable" USING GIST (route_geom);
```

## 4. Contoh pemakaian via `prisma.$queryRaw`

```ts
// Simpan titik (longitude DULU, lalu latitude — urutan X,Y!)
await prisma.$queryRaw`
  UPDATE "Customer"
  SET geom = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
  WHERE id = ${customerId}`;

// ODP terdekat dalam radius 500 m dari kandidat (untuk survei kelayakan)
const nearest = await prisma.$queryRaw<Array<{ id: number; code: string; dist_m: number }>>`
  SELECT id, code, ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) AS dist_m
  FROM "Odp"
  WHERE geom IS NOT NULL
    AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, 500)
  ORDER BY dist_m ASC
  LIMIT 5`;
```

## Catatan

- `Unsupported` berarti kolom **diabaikan** Prisma Client: tidak bisa dipakai di
  `select`/`where`/`create`. Semua operasi spasial lewat `$queryRaw` seperti contoh di atas.
- Kalau suatu saat kolom geometry ingin dikelola penuh oleh Prisma, ganti tipe
  `Unsupported(...)` menjadi `Bytes` tidak cukup — gunakan raw SQL saja sesuai pola di atas.
- File SQL ini sengaja tidak ditaruh di `migrations/` otomatis agar `prisma migrate`
  tidak mencoba memvalidasi tipe yang tidak dikenalnya.
