import type { PrismaClient, Tenant as PrismaTenant } from "./prisma-client.js";
import { TenantId } from "@notification-system/shared-kernel";
import {
  Tenant,
  type TenantRepository,
} from "@notification-system/domain-identity";

function toDomain(row: PrismaTenant): Tenant {
  return Tenant.reconstitute({
    id: TenantId(row.id),
    name: row.name,
    createdAt: row.createdAt,
  });
}

export class PostgresTenantRepository implements TenantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: TenantId): Promise<Tenant | null> {
    const row = await this.prisma.tenant.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async save(tenant: Tenant): Promise<void> {
    await this.prisma.tenant.upsert({
      where: { id: tenant.id },
      create: {
        id: tenant.id,
        name: tenant.name,
        createdAt: tenant.createdAt,
      },
      update: {
        name: tenant.name,
      },
    });
  }
}
