# ADR 0007: Fastify as a long-lived process, not API Gateway/Lambda or Express

## Status
Accepted

## Context
`services/api` is the ingress for `POST/GET /v1/notifications` and the
preference endpoints (see [`api-spec.md`](../architecture/api-spec.md)).
Two separate questions needed deciding: (1) does it run as a long-lived
server process or as Lambda functions behind a managed API Gateway, and (2)
if it's a long-lived process, which Node HTTP framework.

## Decision
`services/api` runs as a long-lived Fastify process, deployed as a container —
the same container image locally (Docker Compose) and on the Phase 1.5
free-tier host.

## Rationale

### Process model: long-lived server, not Lambda + API Gateway
- **Local/hosted parity ([ADR 0006](0006-local-first-free-tier-infra.md)).**
  Phase 1 targets `docker compose up` locally and Fly.io/Railway for the
  hosted demo — both run containers, not Lambda. Building for API Gateway
  now would make local dev and the hosted demo diverge from day one.
- **Connection-heavy workload.** `services/api` holds a Postgres pool and talks
  to RabbitMQ and Redis per request. Lambda's per-invocation lifecycle
  fights connection pooling (cold starts, connection exhaustion under
  concurrency) — solvable, but only with extra AWS-specific machinery paid
  for no benefit at this scale.
- **Migration path stays additive.** The optional Phase 4 AWS target is
  already ECS Fargate, not Lambda (see
  [`infra-strategy.md`](../architecture/infra-strategy.md)). A plain
  container drops behind an ALB unchanged — or behind an API Gateway HTTP
  API in front of that ALB, if its WAF/throttling/custom-domain features
  are wanted later — with zero code changes. Building on Lambda now would
  make the already-planned Fargate path the one requiring a rewrite.
- **Rate limiting/idempotency/tenant auth stay in the domain layer.**
  These are business rules (a tenant's per-channel send budget, quiet
  hours), not just edge throttling — see
  [`multi-tenancy.md`](../architecture/multi-tenancy.md). Keeping them
  behind the `RateLimiter`/`ApiKey` ports instead of an API Gateway usage
  plan keeps that logic testable, portable (works identically with no
  gateway in front, e.g. on Fly.io), and inside the DDD boundary rather
  than split across an AWS console and application code.

### Framework: Fastify, not Express
- **Async-native error handling.** Every route in this system touches
  Postgres, RabbitMQ, or Redis, so every handler is async. Express 4
  (still the dominant version in the ecosystem) does not route a rejected
  promise inside a handler to its error middleware without an added
  wrapper (`express-async-errors`) — a silent-failure footgun for an
  all-async API. Fastify handles this natively.
- **Encapsulation matches the bounded-context structure.** Fastify's
  plugin system gives each `fastify.register()` call its own dependency
  scope unless explicitly decorated onto the parent. Each bounded
  context's routes (`domain-notification`, `domain-preferences`,
  `domain-identity`) register as their own plugin, decorated only with
  that context's wired dependencies — enforcing at the framework level the
  same non-coupling [ADR 0005](0005-ddd-hexagonal-architecture.md) already
  requires of the package structure. Express has no equivalent construct;
  the same isolation would be convention only.
- **Schema-driven validation and serialization from one definition.** A
  route's JSON Schema (or Zod/TypeBox) both validates the request and
  compiles a faster response serializer, instead of validation and
  response-shaping being two independently maintained pieces of code.
- **Built-in Pino logging** matches the structured-logging/correlation-id
  approach already assumed in [`overview.md`](../architecture/overview.md),
  with no extra wiring.
- **Lower per-request overhead** (radix-tree routing, compiled
  serialization) stretches the free-tier compute budget from
  [ADR 0006](0006-local-first-free-tier-infra.md) further than Express's
  regex-based router would.

## Consequences
- Smaller ecosystem and hiring familiarity than Express — a real cost,
  accepted here because the project's goal is to demonstrate
  distributed-systems/DDD judgment, not to optimize for lowest-common-
  denominator framework recognition.
- If AWS API Gateway's edge features (WAF, custom domains, usage plans) are
  wanted later, they can be added in front of the existing Fastify
  container on ALB/ECS Fargate (Phase 4) without changing `services/api` code —
  this decision does not foreclose that option, it just doesn't build for
  it now.
