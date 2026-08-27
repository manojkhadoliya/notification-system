import type { PrismaClient, ApiKey as PrismaApiKey } from "./prisma-client.js";
import { ApiKeyId, TenantId } from "@notification-system/shared-kernel";
import {
  ApiKey,
  type ApiKeyRepository,
} from "@notification-system/domain-identity";

function toDomain(row: PrismaApiKey): ApiKey {
  return ApiKey.reconstitute({
    id: ApiKeyId(row.id),
    tenantId: TenantId(row.tenantId),
    hashedKey: row.hashedKey,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  });
}

export class PostgresApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: ApiKeyId): Promise<ApiKey | null> {
    const row = await this.prisma.apiKey.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findByHashedKey(hashedKey: string): Promise<ApiKey | null> {
    const row = await this.prisma.apiKey.findUnique({
      where: { hashedKey },
    });
    return row === null ? null : toDomain(row);
  }

  async save(apiKey: ApiKey): Promise<void> {
    await this.prisma.apiKey.upsert({
      where: { id: apiKey.id },
      create: {
        id: apiKey.id,
        tenantId: apiKey.tenantId,
        hashedKey: apiKey.hashedKey,
        createdAt: apiKey.createdAt,
        revokedAt: apiKey.revokedAt,
      },
      update: {
        revokedAt: apiKey.revokedAt,
      },
    });
  }
}
