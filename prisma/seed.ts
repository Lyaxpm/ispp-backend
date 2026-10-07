/**
 * Seed awal database ISP Platform.
 *
 * Jalankan dengan:  npx prisma db seed   (atau: npm run prisma:seed)
 *
 * Membuat (idempotent via upsert):
 *  - 1 admin  (admin@isp.local / admin123)
 *  - 1 user NOC, 1 kasir, 1 CS, 1 teknisi
 *  - 3 paket layanan
 *  - Settings billing (PPN_RATE, GRACE_PERIOD_DAYS, dst.)
 *  - 1 NasRouter (MikroTik) + 1 OLT + 1 PON port + 1 ODP + 8 port ODP
 *  - 1 akun demo portal pelanggan (pelanggan@contoh.id / pelanggan123)
 *
 * Syarat: CREDENTIALS_KEY harus di-set di environment sebelum menjalankan
 * seed ini, karena password router/OLT disimpan terenkripsi (AES-256-GCM).
 */
import { PrismaClient, RoleName, ServiceType, BillingType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { encrypt } from '../src/common/utils/crypto.util';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  if (!process.env.CREDENTIALS_KEY) {
    throw new Error('CREDENTIALS_KEY belum di-set. Isi di .env sebelum menjalankan seed.');
  }

  const passwordHash = await bcrypt.hash('admin123', 12);

  // ── Users ──────────────────────────────────────────────────────────────
  const admin = await prisma.user.upsert({
    where: { email: 'admin@isp.local' },
    update: {},
    create: {
      name: 'Administrator',
      email: 'admin@isp.local',
      passwordHash,
      role: RoleName.ADMIN,
      isActive: true,
    },
  });

  const seedUsers: Array<{ name: string; email: string; role: RoleName }> = [
    { name: 'NOC Operator', email: 'noc@isp.local', role: RoleName.NOC },
    { name: 'Kasir Utama', email: 'kasir@isp.local', role: RoleName.CASHIER },
    { name: 'Customer Service', email: 'cs@isp.local', role: RoleName.CS },
    { name: 'Teknisi Lapangan', email: 'teknisi@isp.local', role: RoleName.TECHNICIAN },
  ];
  for (const u of seedUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { ...u, passwordHash, isActive: true },
    });
  }
  console.log(`✔ users (admin id=${admin.id})`);

  // ── Packages ───────────────────────────────────────────────────────────
  const packages: Array<{
    name: string;
    downloadMbps: number;
    uploadMbps: number;
    price: string;
    serviceType: ServiceType;
    billingType: BillingType;
    mikrotikProfile: string;
    radiusRateLimit: string;
  }> = [
    {
      name: 'Home 20 Mbps',
      downloadMbps: 20,
      uploadMbps: 5,
      price: '150000',
      serviceType: ServiceType.PPPOE,
      billingType: BillingType.PREPAID,
      mikrotikProfile: 'paket-20M',
      radiusRateLimit: '5M/20M',
    },
    {
      name: 'Home 50 Mbps',
      downloadMbps: 50,
      uploadMbps: 10,
      price: '250000',
      serviceType: ServiceType.PPPOE,
      billingType: BillingType.PREPAID,
      mikrotikProfile: 'paket-50M',
      radiusRateLimit: '10M/50M',
    },
    {
      name: 'Bisnis 100 Mbps',
      downloadMbps: 100,
      uploadMbps: 50,
      price: '750000',
      serviceType: ServiceType.PPPOE,
      billingType: BillingType.POSTPAID,
      mikrotikProfile: 'paket-100M',
      radiusRateLimit: '50M/100M',
    },
  ];
  for (const p of packages) {
    await prisma.package.upsert({
      where: { name: p.name },
      update: {},
      create: {
        name: p.name,
        downloadMbps: p.downloadMbps,
        uploadMbps: p.uploadMbps,
        price: p.price,
        validityDays: 30,
        serviceType: p.serviceType,
        billingType: p.billingType,
        installFee: '150000',
        setupFee: '0',
        description: `Paket ${p.name} — internet unlimited`,
        isActive: true,
        mikrotikProfile: p.mikrotikProfile,
        radiusRateLimit: p.radiusRateLimit,
      },
    });
  }
  console.log('✔ 3 packages');

  // ── Settings ───────────────────────────────────────────────────────────
  const settings: Array<{ key: string; value: string; description: string }> = [
    { key: 'PPN_RATE', value: process.env.PPN_RATE ?? '11', description: 'Tarif PPN (%) untuk invoice' },
    { key: 'GRACE_PERIOD_DAYS', value: process.env.GRACE_PERIOD_DAYS ?? '3', description: 'Masa tenggang sebelum isolir (hari)' },
    { key: 'ISOLATION_TIER1_DAYS', value: process.env.ISOLATION_TIER1_DAYS ?? '7', description: 'Hari overdue untuk isolir tier-1 (throttle)' },
    { key: 'ISOLATION_TIER2_DAYS', value: process.env.ISOLATION_TIER2_DAYS ?? '14', description: 'Hari overdue untuk isolir tier-2 (blokir total)' },
    { key: 'COMPANY_NAME', value: 'Gen ISP', description: 'Nama perusahaan untuk invoice & notifikasi' },
  ];
  for (const s of settings) {
    await prisma.setting.upsert({
      where: { key: s.key },
      update: { value: s.value },
      create: s,
    });
  }
  console.log('✔ settings');

  // ── NasRouter ──────────────────────────────────────────────────────────
  const router = await prisma.nasRouter.upsert({
    where: { name: 'BNG-JKT-01' },
    update: {},
    create: {
      name: 'BNG-JKT-01',
      host: '192.168.88.1',
      apiPort: 8728,
      username: 'admin',
      passwordEncrypted: encrypt('ganti-password-router'),
      useTls: false,
      location: 'POP Jakarta Pusat',
      isActive: true,
    },
  });
  console.log(`✔ nas_router id=${router.id}`);

  // ── OLT + PON + ODP ────────────────────────────────────────────────────
  const olt = await prisma.olt.upsert({
    where: { name: 'OLT-JKT-01' },
    update: {},
    create: {
      name: 'OLT-JKT-01',
      vendor: 'HUAWEI',
      model: 'MA5800-X7',
      mgmtIp: '192.168.100.2',
      snmpCommunity: 'public',
      snmpVersion: 2,
      sshUsername: 'root',
      sshPasswordEncrypted: encrypt('ganti-password-olt'),
      popLocation: 'POP Jakarta Pusat',
      latitude: -6.2,
      longitude: 106.8167,
      slotCount: 2,
      ponPerSlot: 16,
      status: 'ACTIVE',
    },
  });

  const pon = await prisma.ponPort.upsert({
    where: { oltId_slotNo_ponNo: { oltId: olt.id, slotNo: 0, ponNo: 1 } },
    update: {},
    create: { oltId: olt.id, slotNo: 0, ponNo: 1, name: '0/1/1', status: 'ACTIVE' },
  });

  const odp = await prisma.odp.upsert({
    where: { code: 'ODP-JKT-001' },
    update: {},
    create: {
      code: 'ODP-JKT-001',
      name: 'ODP Jl. Merdeka No. 1',
      ponPortId: pon.id,
      latitude: -6.2012,
      longitude: 106.8181,
      capacity: 8,
      usedPorts: 0,
      status: 'ACTIVE',
    },
  });

  for (let portNo = 1; portNo <= 8; portNo++) {
    await prisma.odpPort.upsert({
      where: { odpId_portNo: { odpId: odp.id, portNo } },
      update: {},
      create: { odpId: odp.id, portNo, status: 'FREE' },
    });
  }
  console.log(`✔ olt id=${olt.id}, pon id=${pon.id}, odp id=${odp.id} (+8 port)`);

  // ── Akun demo portal pelanggan ─────────────────────────────────────────
  // Idempoten: dilewati bila akun sudah ada. Butuh minimal 1 customer —
  // bila belum ada, buat customer demo dulu agar portal bisa langsung dicoba.
  try {
    let demoCustomer = await prisma.customer.findFirst({ orderBy: { id: 'asc' } });
    if (!demoCustomer) {
      demoCustomer = await prisma.customer.create({
        data: {
          customerNo: 'DEMO-0001',
          name: 'Pelanggan Demo',
          phone: '081200000001',
          address: 'Jl. Contoh No. 1, Jakarta',
          status: 'ACTIVE',
        },
      });
      console.log(`✔ customer demo id=${demoCustomer.id} dibuat`);
    }
    const existingAccount = await prisma.customerAccount.findUnique({
      where: { email: 'pelanggan@contoh.id' },
    });
    if (!existingAccount) {
      await prisma.customerAccount.create({
        data: {
          customerId: demoCustomer.id,
          email: 'pelanggan@contoh.id',
          passwordHash: await bcrypt.hash('pelanggan123', 10),
        },
      });
      console.log('✔ akun portal demo: pelanggan@contoh.id / pelanggan123');
    } else {
      console.log('✔ akun portal demo sudah ada — dilewati');
    }
  } catch (err) {
    console.warn(
      '⚠ seed akun portal dilewati:',
      err instanceof Error ? err.message : err,
    );
  }

  console.log('\nSeed selesai. Login admin: admin@isp.local / admin123');
}

main()
  .catch((err: unknown) => {
    console.error('Seed gagal:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
