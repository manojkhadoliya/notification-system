import { ApiKeyId, TenantId } from "@notification-system/shared-kernel";
import type { Tenant } from "./tenant.js";
import type { ApiKey } from "./api-key.js";

export interface TenantRepository {
  findById(id: TenantId): Promise<Tenant | null>;
  save(tenant: Tenant): Promise<void>;
}

export interface ApiKeyRepository {
  findById(id: ApiKeyId): Promise<ApiKey | null>;
  /** The only lookup `services/api`'s auth middleware actually needs — see
   * multi-tenancy.md#auth: a request carries a raw key, the caller hashes
   * it, and this resolves the hash to whichever `ApiKey` currently owns
   * it (if any — a rotated-out hash matches nothing). */
  findByHashedKey(hashedKey: string): Promise<ApiKey | null>;
  save(apiKey: ApiKey): Promise<void>;
}
