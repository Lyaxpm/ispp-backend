import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GisFtthService, GeoJsonLayer } from '../../services/gis-ftth.service';
import { OltService } from '../olt/olt.service';
import { CreateOdcDto, CreateOdpDto } from '../olt/dto/create-odp.dto';

/**
 * Thin wrapper di atas GisFtthService + OltService.
 * - Logika spasial & impact engine: GisFtthService.
 * - Provisioning & CRUD OLT/PON/ODC/ODP/ONU: OltService.
 * - photoUrl: kolom photoUrl sudah ada di skema Odc/Odp, diteruskan apa adanya.
 */
@Injectable()
export class GisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gis: GisFtthService,
    private readonly olt: OltService,
  ) {}

  // ---------------- delegasi ke GisFtthService ----------------

  /**
   * ODP terdekat — dipetakan ke bentuk yang dimengerti frontend
   * (distanceMeters, capacity, id string).
   */
  async nearestOdp(lat: number, lng: number, radius?: number) {
    const rows = await this.gis.findNearestOdp(lat, lng, radius ?? 500, 5);
    const ids = rows.map((r) => r.id);
    const odps = await this.prisma.odp.findMany({
      where: { id: { in: ids } },
      select: { id: true, capacity: true, usedPorts: true, status: true },
    });
    const byId = new Map(odps.map((o) => [o.id, o]));
    return rows.map((r) => {
      const o = byId.get(r.id);
      const capacity = o?.capacity ?? r.freePorts;
      return {
        id: String(r.id),
        code: r.code,
        name: r.name,
        latitude: r.latitude,
        longitude: r.longitude,
        capacity,
        usedPorts: Math.max(0, capacity - r.freePorts),
        freePorts: r.freePorts,
        status: o?.status ?? 'ACTIVE',
        distanceMeters: r.distM,
      };
    });
  }

  coverage(lat: number, lng: number) {
    return this.gis.checkCoverage(lat, lng);
  }

  topology(oltId: number) {
    return this.gis.getTopologyTree(oltId);
  }

  geojson(layer: GeoJsonLayer) {
    return this.gis.exportGeoJSON(layer);
  }

  async outageImpact(nodeType: 'OLT' | 'PON_PORT' | 'ODC' | 'ODP', nodeId: number) {
    const impact = await this.gis.calculateOutageImpact(nodeType, nodeId);
    const notification = await this.gis.notifyOutageImpact(impact);
    return { ...impact, notification };
  }

  assignOdpPort(customerId: number, odpId: number, actorId?: number) {
    return this.gis.assignCustomerToOdpPort(customerId, odpId, actorId);
  }

  releaseOdpPort(customerId: number, actorId?: number) {
    return this.gis.releaseOdpPort(customerId, actorId);
  }

  // ---------------- CRUD node infrastruktur (via OltService) ----------------

  listOdps(params: { status?: string; search?: string; skip?: number; take?: number }) {
    return this.olt.listOdps(params);
  }

  createOdp(dto: CreateOdpDto, actorId?: number) {
    return this.olt.createOdp(dto, actorId);
  }

  updateOdp(id: number, dto: Partial<CreateOdpDto>, actorId?: number) {
    return this.olt.updateOdp(id, dto, actorId);
  }

  deleteOdp(id: number, actorId?: number) {
    return this.olt.deleteOdp(id, actorId);
  }

  listOdcs(params: { search?: string; skip?: number; take?: number }) {
    return this.olt.listOdcs(params);
  }

  createOdc(dto: CreateOdcDto, actorId?: number) {
    return this.olt.createOdc(dto, actorId);
  }

  updateOdc(id: number, dto: Partial<CreateOdcDto>, actorId?: number) {
    return this.olt.updateOdc(id, dto, actorId);
  }

  listOlts(params: { search?: string; skip?: number; take?: number }) {
    return this.olt.listOlts(params);
  }

  async nodeSummary() {
    const [olt, odc, odp, onu, customer] = await Promise.all([
      this.prisma.olt.count(),
      this.prisma.odc.count(),
      this.prisma.odp.count(),
      this.prisma.onu.count(),
      this.prisma.customer.count(),
    ]);
    return { olt, odc, odp, onu, customer };
  }
}
