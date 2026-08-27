import type { Channel, TenantId } from "@notification-system/shared-kernel";

/**
 * Per-tenant, per-channel request budget — a token bucket. See
 * multi-tenancy.md#rate-limiting. `capacity` is the bucket size (max burst);
 * `refillPerSecond` is the sustained rate. Defined per tenant so paid vs.
 * free-tier tenants can differ without changing the enforcement mechanism.
 */
export interface RateLimitPolicy {
  readonly tenantId: TenantId;
  readonly channel: Channel;
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export function createDefaultRateLimitPolicy(
  tenantId: TenantId,
  channel: Channel,
): RateLimitPolicy {
  // Same illustrative-not-measured caveat as everywhere else in this repo
  // (see scaling-strategy.md) — a placeholder every tenant starts with
  // until there's a real reason to differentiate.
  return { tenantId, channel, capacity: 100, refillPerSecond: 10 };
}

/**
 * Enforces a `RateLimitPolicy` — the token-bucket mechanics live in the
 * adapter (`infra-redis`); this port only exposes the decision a caller
 * needs. See multi-tenancy.md#rate-limiting.
 */
export interface RateLimiter {
  /** Attempts to consume one token for `(tenantId, channel)`. Returns
   * `true` if a token was available (and consumed), `false` if the bucket
   * was empty — never throws for "over budget", since that's an expected
   * outcome the caller branches on (429 at ingest, requeue with backoff at
   * dispatch — see multi-tenancy.md#rate-limiting), not an error. */
  tryConsume(tenantId: TenantId, channel: Channel): Promise<boolean>;
}
