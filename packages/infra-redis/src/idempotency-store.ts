import type { Redis } from "ioredis";
import type { TenantId } from "@notification-system/shared-kernel";
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from "@notification-system/domain-notification";

// See multi-tenancy.md#idempotency's "e.g. 24h".
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** `IdempotencyStore` port implementation — see that port's doc comment
 * (`domain-notification/src/idempotency.ts`) for the `find`/`reserve`
 * contract and its documented race (this adapter doesn't add atomicity
 * beyond what the port promises). */
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async find(
    tenantId: TenantId,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null> {
    const raw = await this.redis.get(this.key(tenantId, idempotencyKey));
    return raw === null ? null : (JSON.parse(raw) as IdempotencyRecord);
  }

  async reserve(
    tenantId: TenantId,
    idempotencyKey: string,
    record: IdempotencyRecord,
  ): Promise<void> {
    await this.redis.set(
      this.key(tenantId, idempotencyKey),
      JSON.stringify(record),
      "PX",
      this.ttlMs,
    );
  }

  private key(tenantId: TenantId, idempotencyKey: string): string {
    return `idempotency:${tenantId}:${idempotencyKey}`;
  }
}
