# packages/domain-identity

The **Identity & Tenancy** bounded context. Owns `Tenant` and `ApiKey`
entities and the `RateLimitPolicy`. Defines `TenantRepository`,
`ApiKeyRepository`, and `RateLimiter` ports, used by `services/api` for
authentication and by every worker for rate-limit enforcement at dispatch
time.

Zero imports of Prisma, Redis client, or any other infra package.

**Implemented by:** `infra-postgres` (repositories), `infra-redis`
(`RateLimiter`).

**Delivered in:** Phase 1. Full model in
[`../../docs/architecture/domain-model.md`](../../docs/architecture/domain-model.md).
