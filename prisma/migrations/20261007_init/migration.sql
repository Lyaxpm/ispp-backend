-- CreateEnum
CREATE TYPE "RoleName" AS ENUM ('ADMIN', 'NOC', 'CASHIER', 'TECHNICIAN', 'CS', 'RESELLER');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('CANDIDATE', 'TRIAL', 'ACTIVE', 'ISOLATED', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('RETAIL', 'CORPORATE', 'RESELLER');

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('PPPOE', 'STATIC_IP', 'DHCP', 'HOTSPOT');

-- CreateEnum
CREATE TYPE "BillingType" AS ENUM ('PREPAID', 'POSTPAID');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'VIRTUAL_ACCOUNT', 'QRIS', 'EWALLET', 'RETAIL', 'CASH', 'GATEWAY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OltVendor" AS ENUM ('HUAWEI', 'ZTE', 'FIBERHOME', 'HSGQ', 'CDATA', 'HIOSO');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'DOWN');

-- CreateEnum
CREATE TYPE "OdpPortStatus" AS ENUM ('FREE', 'USED', 'RESERVED', 'DAMAGED');

-- CreateEnum
CREATE TYPE "OnuStatus" AS ENUM ('ONLINE', 'OFFLINE', 'LOS', 'UNCONFIGURED', 'DEGRADED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "WorkOrderType" AS ENUM ('INSTALL', 'RELOCATE', 'UPGRADE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('DRAFT', 'ASSIGNED', 'ON_SITE', 'DONE', 'VERIFIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CableType" AS ENUM ('FEEDER', 'DISTRIBUTION', 'DROP');

-- CreateEnum
CREATE TYPE "CoreStatus" AS ENUM ('FREE', 'IN_USE', 'DAMAGED', 'RESERVED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('WHATSAPP', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "NasType" AS ENUM ('MIKROTIK');

-- CreateEnum
CREATE TYPE "InventoryCategory" AS ENUM ('ROUTER', 'ONU', 'FIBER', 'SPLITTER', 'OTHER');

-- CreateEnum
CREATE TYPE "InventoryStatus" AS ENUM ('IN_STOCK', 'ASSIGNED', 'DEFECTIVE');

-- CreateEnum
CREATE TYPE "IpPoolType" AS ENUM ('PRIVATE', 'PUBLIC', 'CGNAT');

-- CreateEnum
CREATE TYPE "IpAllocationStatus" AS ENUM ('FREE', 'ALLOCATED', 'RESERVED');

-- CreateEnum
CREATE TYPE "VlanPurpose" AS ENUM ('INTERNET', 'IPTV', 'VOIP', 'MGMT');

-- CreateEnum
CREATE TYPE "SplitterLevel" AS ENUM ('PRIMARY', 'SECONDARY');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'PAID');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "RoleName" NOT NULL,
    "resellerId" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" SERIAL NOT NULL,
    "customerNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "ktpNumber" TEXT,
    "address" TEXT NOT NULL,
    "village" TEXT,
    "district" TEXT,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "geom" geometry(Point,4326),
    "status" "CustomerStatus" NOT NULL DEFAULT 'CANDIDATE',
    "type" "CustomerType" NOT NULL DEFAULT 'RETAIL',
    "notes" TEXT,
    "packageId" INTEGER,
    "nasRouterId" INTEGER,
    "onuId" INTEGER,
    "odpPortId" INTEGER,
    "serviceType" "ServiceType" NOT NULL DEFAULT 'PPPOE',
    "billingType" "BillingType" NOT NULL DEFAULT 'PREPAID',
    "dueDay" INTEGER NOT NULL DEFAULT 10,
    "graceDays" INTEGER NOT NULL DEFAULT 3,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "installDate" TIMESTAMP(3),
    "activeDate" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceLog" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "downloadMbps" INTEGER NOT NULL,
    "uploadMbps" INTEGER NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "validityDays" INTEGER NOT NULL DEFAULT 30,
    "fupGb" INTEGER,
    "serviceType" "ServiceType" NOT NULL,
    "billingType" "BillingType" NOT NULL,
    "installFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "setupFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mikrotikProfile" TEXT,
    "radiusRateLimit" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "packageId" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "priceOverride" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "subscriptionId" INTEGER,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "ppn" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "adminFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "penalty" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER,
    "customerId" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "channel" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT NOT NULL,
    "proofUrl" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "confirmedById" INTEGER,
    "rawWebhook" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResellerCommission" (
    "id" SERIAL NOT NULL,
    "resellerId" INTEGER NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResellerCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voucher" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "discountPercent" DECIMAL(5,2),
    "discountAmount" DECIMAL(14,2),
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NasRouter" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "apiPort" INTEGER NOT NULL DEFAULT 8728,
    "username" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "useTls" BOOLEAN NOT NULL DEFAULT false,
    "type" "NasType" NOT NULL DEFAULT 'MIKROTIK',
    "location" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NasRouter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Olt" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "vendor" "OltVendor" NOT NULL,
    "model" TEXT NOT NULL,
    "mgmtIp" TEXT NOT NULL,
    "snmpCommunity" TEXT NOT NULL DEFAULT 'public',
    "snmpVersion" INTEGER NOT NULL DEFAULT 2,
    "sshUsername" TEXT,
    "sshPasswordEncrypted" TEXT,
    "popLocation" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "geom" geometry(Point,4326),
    "slotCount" INTEGER NOT NULL DEFAULT 2,
    "ponPerSlot" INTEGER NOT NULL DEFAULT 16,
    "uplinkInfo" TEXT,
    "status" "NodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Olt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PonPort" (
    "id" SERIAL NOT NULL,
    "oltId" INTEGER NOT NULL,
    "slotNo" INTEGER NOT NULL,
    "ponNo" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "NodeStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "PonPort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Odc" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ponPortId" INTEGER,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "geom" geometry(Point,4326),
    "capacity" INTEGER NOT NULL DEFAULT 144,
    "status" "NodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "photoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Odc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Odp" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "odcId" INTEGER,
    "ponPortId" INTEGER,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "geom" geometry(Point,4326),
    "capacity" INTEGER NOT NULL DEFAULT 8,
    "usedPorts" INTEGER NOT NULL DEFAULT 0,
    "status" "NodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "photoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Odp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdpPort" (
    "id" SERIAL NOT NULL,
    "odpId" INTEGER NOT NULL,
    "portNo" INTEGER NOT NULL,
    "status" "OdpPortStatus" NOT NULL DEFAULT 'FREE',
    "customerId" INTEGER,

    CONSTRAINT "OdpPort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Onu" (
    "id" SERIAL NOT NULL,
    "sn" TEXT NOT NULL,
    "mac" TEXT,
    "model" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "firmware" TEXT,
    "oltId" INTEGER,
    "ponPortId" INTEGER,
    "ontId" TEXT,
    "rxPower" DOUBLE PRECISION,
    "txPower" DOUBLE PRECISION,
    "status" "OnuStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "lastSeen" TIMESTAMP(3),
    "customerId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Onu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Splitter" (
    "id" SERIAL NOT NULL,
    "odpId" INTEGER,
    "odcId" INTEGER,
    "ratio" TEXT NOT NULL,
    "level" "SplitterLevel" NOT NULL,

    CONSTRAINT "Splitter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiberCable" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cableType" "CableType" NOT NULL,
    "coreCount" INTEGER NOT NULL,
    "lengthM" DOUBLE PRECISION,
    "routeGeom" geometry(LineString,4326),
    "fromNode" TEXT NOT NULL,
    "toNode" TEXT NOT NULL,
    "status" "CoreStatus" NOT NULL DEFAULT 'FREE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiberCable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpPool" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "gateway" TEXT,
    "dnsPrimary" TEXT,
    "dnsSecondary" TEXT,
    "poolType" "IpPoolType" NOT NULL,
    "nasRouterId" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IpPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpAllocation" (
    "id" SERIAL NOT NULL,
    "poolId" INTEGER NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "customerId" INTEGER,
    "status" "IpAllocationStatus" NOT NULL DEFAULT 'FREE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IpAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vlan" (
    "id" SERIAL NOT NULL,
    "vlanId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" "VlanPurpose" NOT NULL,
    "oltId" INTEGER,

    CONSTRAINT "Vlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaticLease" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "macAddress" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "nasRouterId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaticLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadCheck" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "attribute" TEXT NOT NULL DEFAULT 'Cleartext-Password',
    "op" TEXT NOT NULL DEFAULT ':=',
    "value" TEXT NOT NULL,

    CONSTRAINT "RadCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadReply" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "attribute" TEXT NOT NULL,
    "op" TEXT NOT NULL DEFAULT '=',
    "value" TEXT NOT NULL,

    CONSTRAINT "RadReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadAcct" (
    "id" SERIAL NOT NULL,
    "acctSessionId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "nasIpAddress" TEXT NOT NULL,
    "framedIpAddress" TEXT,
    "acctStartTime" TIMESTAMP(3),
    "acctStopTime" TIMESTAMP(3),
    "acctSessionTime" INTEGER,
    "acctInputOctets" BIGINT,
    "acctOutputOctets" BIGINT,

    CONSTRAINT "RadAcct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" INTEGER,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "reportedById" INTEGER NOT NULL,
    "assignedToId" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "type" "WorkOrderType" NOT NULL,
    "customerId" INTEGER NOT NULL,
    "technicianId" INTEGER,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "checklist" JSONB,
    "photos" JSONB,
    "gpsLat" DOUBLE PRECISION,
    "gpsLng" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" SERIAL NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "InventoryCategory" NOT NULL,
    "serialNumber" TEXT,
    "macAddress" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "warehouse" TEXT NOT NULL DEFAULT 'Gudang Utama',
    "status" "InventoryStatus" NOT NULL DEFAULT 'IN_STOCK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" SERIAL NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "actorId" INTEGER,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "diff" JSONB,
    "ipAddress" TEXT,
    "customerId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_resellerId_idx" ON "User"("resellerId");

-- CreateIndex
CREATE INDEX "User_isActive_idx" ON "User"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_customerNo_key" ON "Customer"("customerNo");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_onuId_key" ON "Customer"("onuId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_odpPortId_key" ON "Customer"("odpPortId");

-- CreateIndex
CREATE INDEX "Customer_status_idx" ON "Customer"("status");

-- CreateIndex
CREATE INDEX "Customer_type_idx" ON "Customer"("type");

-- CreateIndex
CREATE INDEX "Customer_packageId_idx" ON "Customer"("packageId");

-- CreateIndex
CREATE INDEX "Customer_nasRouterId_idx" ON "Customer"("nasRouterId");

-- CreateIndex
CREATE INDEX "Customer_name_idx" ON "Customer"("name");

-- CreateIndex
CREATE INDEX "Customer_city_idx" ON "Customer"("city");

-- CreateIndex
CREATE INDEX "Customer_createdAt_idx" ON "Customer"("createdAt");

-- CreateIndex
CREATE INDEX "ServiceLog_customerId_idx" ON "ServiceLog"("customerId");

-- CreateIndex
CREATE INDEX "ServiceLog_action_idx" ON "ServiceLog"("action");

-- CreateIndex
CREATE INDEX "ServiceLog_createdAt_idx" ON "ServiceLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Package_name_key" ON "Package"("name");

-- CreateIndex
CREATE INDEX "Package_isActive_idx" ON "Package"("isActive");

-- CreateIndex
CREATE INDEX "Package_serviceType_idx" ON "Package"("serviceType");

-- CreateIndex
CREATE INDEX "Subscription_customerId_idx" ON "Subscription"("customerId");

-- CreateIndex
CREATE INDEX "Subscription_packageId_idx" ON "Subscription"("packageId");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice"("dueDate");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex
CREATE INDEX "Invoice_number_idx" ON "Invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_customerId_periodStart_periodEnd_key" ON "Invoice"("customerId", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reference_key" ON "Payment"("reference");

-- CreateIndex
CREATE INDEX "Payment_customerId_idx" ON "Payment"("customerId");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_reference_idx" ON "Payment"("reference");

-- CreateIndex
CREATE INDEX "Payment_paidAt_idx" ON "Payment"("paidAt");

-- CreateIndex
CREATE INDEX "ResellerCommission_resellerId_idx" ON "ResellerCommission"("resellerId");

-- CreateIndex
CREATE INDEX "ResellerCommission_status_idx" ON "ResellerCommission"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_code_key" ON "Voucher"("code");

-- CreateIndex
CREATE INDEX "Voucher_isActive_idx" ON "Voucher"("isActive");

-- CreateIndex
CREATE INDEX "Voucher_validTo_idx" ON "Voucher"("validTo");

-- CreateIndex
CREATE UNIQUE INDEX "NasRouter_name_key" ON "NasRouter"("name");

-- CreateIndex
CREATE INDEX "NasRouter_isActive_idx" ON "NasRouter"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Olt_name_key" ON "Olt"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Olt_mgmtIp_key" ON "Olt"("mgmtIp");

-- CreateIndex
CREATE INDEX "Olt_vendor_idx" ON "Olt"("vendor");

-- CreateIndex
CREATE INDEX "Olt_status_idx" ON "Olt"("status");

-- CreateIndex
CREATE INDEX "PonPort_oltId_idx" ON "PonPort"("oltId");

-- CreateIndex
CREATE INDEX "PonPort_status_idx" ON "PonPort"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PonPort_oltId_slotNo_ponNo_key" ON "PonPort"("oltId", "slotNo", "ponNo");

-- CreateIndex
CREATE UNIQUE INDEX "Odc_code_key" ON "Odc"("code");

-- CreateIndex
CREATE INDEX "Odc_ponPortId_idx" ON "Odc"("ponPortId");

-- CreateIndex
CREATE INDEX "Odc_status_idx" ON "Odc"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Odp_code_key" ON "Odp"("code");

-- CreateIndex
CREATE INDEX "Odp_odcId_idx" ON "Odp"("odcId");

-- CreateIndex
CREATE INDEX "Odp_ponPortId_idx" ON "Odp"("ponPortId");

-- CreateIndex
CREATE INDEX "Odp_status_idx" ON "Odp"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OdpPort_customerId_key" ON "OdpPort"("customerId");

-- CreateIndex
CREATE INDEX "OdpPort_odpId_idx" ON "OdpPort"("odpId");

-- CreateIndex
CREATE INDEX "OdpPort_status_idx" ON "OdpPort"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OdpPort_odpId_portNo_key" ON "OdpPort"("odpId", "portNo");

-- CreateIndex
CREATE UNIQUE INDEX "Onu_sn_key" ON "Onu"("sn");

-- CreateIndex
CREATE UNIQUE INDEX "Onu_mac_key" ON "Onu"("mac");

-- CreateIndex
CREATE UNIQUE INDEX "Onu_customerId_key" ON "Onu"("customerId");

-- CreateIndex
CREATE INDEX "Onu_oltId_idx" ON "Onu"("oltId");

-- CreateIndex
CREATE INDEX "Onu_ponPortId_idx" ON "Onu"("ponPortId");

-- CreateIndex
CREATE INDEX "Onu_status_idx" ON "Onu"("status");

-- CreateIndex
CREATE INDEX "Onu_lastSeen_idx" ON "Onu"("lastSeen");

-- CreateIndex
CREATE INDEX "Splitter_odpId_idx" ON "Splitter"("odpId");

-- CreateIndex
CREATE INDEX "Splitter_odcId_idx" ON "Splitter"("odcId");

-- CreateIndex
CREATE UNIQUE INDEX "FiberCable_code_key" ON "FiberCable"("code");

-- CreateIndex
CREATE INDEX "FiberCable_cableType_idx" ON "FiberCable"("cableType");

-- CreateIndex
CREATE INDEX "FiberCable_status_idx" ON "FiberCable"("status");

-- CreateIndex
CREATE UNIQUE INDEX "IpPool_name_key" ON "IpPool"("name");

-- CreateIndex
CREATE INDEX "IpPool_nasRouterId_idx" ON "IpPool"("nasRouterId");

-- CreateIndex
CREATE INDEX "IpPool_isActive_idx" ON "IpPool"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "IpAllocation_customerId_key" ON "IpAllocation"("customerId");

-- CreateIndex
CREATE INDEX "IpAllocation_poolId_idx" ON "IpAllocation"("poolId");

-- CreateIndex
CREATE INDEX "IpAllocation_status_idx" ON "IpAllocation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "IpAllocation_poolId_ipAddress_key" ON "IpAllocation"("poolId", "ipAddress");

-- CreateIndex
CREATE INDEX "Vlan_oltId_idx" ON "Vlan"("oltId");

-- CreateIndex
CREATE INDEX "Vlan_purpose_idx" ON "Vlan"("purpose");

-- CreateIndex
CREATE UNIQUE INDEX "Vlan_oltId_vlanId_key" ON "Vlan"("oltId", "vlanId");

-- CreateIndex
CREATE UNIQUE INDEX "StaticLease_customerId_key" ON "StaticLease"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "StaticLease_ipAddress_key" ON "StaticLease"("ipAddress");

-- CreateIndex
CREATE INDEX "StaticLease_nasRouterId_idx" ON "StaticLease"("nasRouterId");

-- CreateIndex
CREATE INDEX "RadCheck_username_idx" ON "RadCheck"("username");

-- CreateIndex
CREATE UNIQUE INDEX "RadCheck_username_attribute_key" ON "RadCheck"("username", "attribute");

-- CreateIndex
CREATE INDEX "RadReply_username_idx" ON "RadReply"("username");

-- CreateIndex
CREATE INDEX "RadReply_attribute_idx" ON "RadReply"("attribute");

-- CreateIndex
CREATE UNIQUE INDEX "RadAcct_acctSessionId_key" ON "RadAcct"("acctSessionId");

-- CreateIndex
CREATE INDEX "RadAcct_username_idx" ON "RadAcct"("username");

-- CreateIndex
CREATE INDEX "RadAcct_acctStartTime_idx" ON "RadAcct"("acctStartTime");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_number_key" ON "Ticket"("number");

-- CreateIndex
CREATE INDEX "Ticket_status_idx" ON "Ticket"("status");

-- CreateIndex
CREATE INDEX "Ticket_priority_idx" ON "Ticket"("priority");

-- CreateIndex
CREATE INDEX "Ticket_customerId_idx" ON "Ticket"("customerId");

-- CreateIndex
CREATE INDEX "Ticket_assignedToId_idx" ON "Ticket"("assignedToId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_number_key" ON "WorkOrder"("number");

-- CreateIndex
CREATE INDEX "WorkOrder_status_idx" ON "WorkOrder"("status");

-- CreateIndex
CREATE INDEX "WorkOrder_type_idx" ON "WorkOrder"("type");

-- CreateIndex
CREATE INDEX "WorkOrder_customerId_idx" ON "WorkOrder"("customerId");

-- CreateIndex
CREATE INDEX "WorkOrder_technicianId_idx" ON "WorkOrder"("technicianId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_serialNumber_key" ON "InventoryItem"("serialNumber");

-- CreateIndex
CREATE INDEX "InventoryItem_category_idx" ON "InventoryItem"("category");

-- CreateIndex
CREATE INDEX "InventoryItem_status_idx" ON "InventoryItem"("status");

-- CreateIndex
CREATE INDEX "InventoryItem_sku_idx" ON "InventoryItem"("sku");

-- CreateIndex
CREATE INDEX "NotificationLog_status_idx" ON "NotificationLog"("status");

-- CreateIndex
CREATE INDEX "NotificationLog_channel_idx" ON "NotificationLog"("channel");

-- CreateIndex
CREATE INDEX "NotificationLog_template_idx" ON "NotificationLog"("template");

-- CreateIndex
CREATE INDEX "NotificationLog_createdAt_idx" ON "NotificationLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_customerId_idx" ON "AuditLog"("customerId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_nasRouterId_fkey" FOREIGN KEY ("nasRouterId") REFERENCES "NasRouter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_onuId_fkey" FOREIGN KEY ("onuId") REFERENCES "Onu"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_odpPortId_fkey" FOREIGN KEY ("odpPortId") REFERENCES "OdpPort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceLog" ADD CONSTRAINT "ServiceLog_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceLog" ADD CONSTRAINT "ServiceLog_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerCommission" ADD CONSTRAINT "ResellerCommission_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerCommission" ADD CONSTRAINT "ResellerCommission_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PonPort" ADD CONSTRAINT "PonPort_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "Olt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Odc" ADD CONSTRAINT "Odc_ponPortId_fkey" FOREIGN KEY ("ponPortId") REFERENCES "PonPort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Odp" ADD CONSTRAINT "Odp_odcId_fkey" FOREIGN KEY ("odcId") REFERENCES "Odc"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Odp" ADD CONSTRAINT "Odp_ponPortId_fkey" FOREIGN KEY ("ponPortId") REFERENCES "PonPort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OdpPort" ADD CONSTRAINT "OdpPort_odpId_fkey" FOREIGN KEY ("odpId") REFERENCES "Odp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OdpPort" ADD CONSTRAINT "OdpPort_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Onu" ADD CONSTRAINT "Onu_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "Olt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Onu" ADD CONSTRAINT "Onu_ponPortId_fkey" FOREIGN KEY ("ponPortId") REFERENCES "PonPort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Onu" ADD CONSTRAINT "Onu_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Splitter" ADD CONSTRAINT "Splitter_odpId_fkey" FOREIGN KEY ("odpId") REFERENCES "Odp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Splitter" ADD CONSTRAINT "Splitter_odcId_fkey" FOREIGN KEY ("odcId") REFERENCES "Odc"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpPool" ADD CONSTRAINT "IpPool_nasRouterId_fkey" FOREIGN KEY ("nasRouterId") REFERENCES "NasRouter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpAllocation" ADD CONSTRAINT "IpAllocation_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "IpPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpAllocation" ADD CONSTRAINT "IpAllocation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "Olt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaticLease" ADD CONSTRAINT "StaticLease_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaticLease" ADD CONSTRAINT "StaticLease_nasRouterId_fkey" FOREIGN KEY ("nasRouterId") REFERENCES "NasRouter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

