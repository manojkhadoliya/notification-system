import type { Channel, TenantId } from "@notification-system/shared-kernel";

/**
 * `domain-notification`'s own copy of the `RateLimiter` port shape that
 * `domain-identity` also defines (see domain-model.md's decision table:
 * "domain-notification's dispatch service asks the RateLimiter port").
 * Deliberately **not** imported from `domain-identity` — contexts
 * reference each other by id only, never by importing one another's
 * package (see domain-model.md#context-map); a cross-domain-package
 * import here would couple two bounded contexts through a TS dependency
 * edge instead of an id. Both ports are structurally identical, so one
 * concrete `infra-redis` adapter satisfies both without duplication at
 * the implementation level — only the interface declaration is
 * duplicated, which is the cost of interface segregation across a
 * context boundary, not a mistake.
 */
export interface RateLimiter {
  tryConsume(tenantId: TenantId, channel: Channel): Promise<boolean>;
}
