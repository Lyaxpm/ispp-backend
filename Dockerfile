# ── Build stage ─────────────────────────────────────────────────────────────
# Debian slim (bukan alpine): Prisma membutuhkan deteksi OpenSSL 3 yang
# andal saat runtime — di alpine/musl deteksinya gagal dan client default
# ke engine openssl-1.1.x yang tidak ada lib-nya (crash libssl.so.1.1).
FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./

EXPOSE 3000

# Migrasi TIDAK dijalankan otomatis di sini: DATABASE_URL di cloud memakai
# PgBouncer (transaction mode, mis. Supabase pooler port 6543) dan
# `prisma migrate deploy` butuh koneksi langsung (advisory lock) — jalan
# via pooler bisa gagal dan bikin container crash-loop. Jalankan migrasi
# manual dari mesin lokal memakai connection string DIRECT (port 5432):
#   DATABASE_URL="<direct-url>" npx prisma migrate deploy
CMD ["node", "dist/main"]
