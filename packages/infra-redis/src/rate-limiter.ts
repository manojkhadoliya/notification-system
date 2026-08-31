import type { Redis } from "ioredis";
import type { Channel, TenantId } from "@notification-system/shared-kernel";
import {
  createDefaultRateLimitPolicy,
  type RateLimitPolicy,
} from "@notification-system/domain-identity";
import { TOKEN_BUCKET_LUA } from "./token-bucket.js";

export type RateLimitPolicyResolver = (
  tenantId: TenantId,
  channel: Channel,
) => RateLimitPolicy | Promise<RateLimitPolicy>;

// Idle buckets expire rather than accumulate forever for tenant/channel
// pairs that stop sending — an hour comfortably outlasts any policy's
// refill window at this system's illustrative capacity/refillPerSecond
// values (see domain-identity's rate-limit.ts).
const BUCKET_TTL_SECONDS = 3600;

/**
 * Token-bucket `RateLimiter`. Structurally satisfies both
 * `domain-identity`'s and `domain-notification`'s copies of the port (see
 * `domain-notification/src/rate-limiter.ts`'s doc comment for why there
 * are two identical interfaces) — one adapter, no duplicated
 * implementation.
 *
 * There's no `RateLimitPolicy` repository/table yet — policies are
 * currently an illustrative placeholder every tenant starts with (see
 * `domain-identity/src/rate-limit.ts`), not persisted per tenant.
 * `resolvePolicy` defaults to `createDefaultRateLimitPolicy` and exists as
 * a constructor seam for whenever per-tenant policies do land, rather
 * than this adapter inventing its own opinion on where they come from.
 *
 * The read-refill-write happens atomically in Redis via `TOKEN_BUCKET_LUA`
 * (`EVAL`), not in this class — see that script's doc comment for why.
 */
export class RedisRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly resolvePolicy: RateLimitPolicyResolver = createDefaultRateLimitPolicy,
  ) {}

  async tryConsume(tenantId: TenantId, channel: Channel): Promise<boolean> {
    const policy = await this.resolvePolicy(tenantId, channel);
    const key = `ratelimit:${tenantId}:${channel}`;
    const allowed = await this.redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      policy.capacity,
      policy.refillPerSecond,
      Date.now(),
      BUCKET_TTL_SECONDS,
    );
    return allowed === 1;
  }
}
