# ADR 0006: Local-first, free-tier infrastructure

## Status
Accepted

## Context
This is an unfunded portfolio project — no ongoing cloud spend is
acceptable — but it should still demonstrate infrastructure judgment
appropriate to a system that might later need to scale.

## Decision
Phase 1 runs entirely on local Docker Compose (Postgres, RabbitMQ, Redis).
A subsequent Phase 1.5 hosts the same stack on free tiers of
wire-compatible managed services (Fly.io/Railway, Supabase/Neon, CloudAMQP,
Upstash). A paid, scaled AWS deployment (Terraform, ECS Fargate, RDS,
ElastiCache, Amazon MQ) is documented as an optional future phase but not
built. Full detail in
[`infra-strategy.md`](../architecture/infra-strategy.md).

## Rationale
Every free-tier service chosen speaks the same open protocol as its paid,
scaled equivalent (Postgres, AMQP 0-9-1, Redis protocol) rather than a
proprietary managed API — combined with the ports-and-adapters structure
from ADR 0005, this means the eventual scale-out is a configuration and
hosting change, not an application rewrite. This directly answers the
requirement that infra be free/local now but have "scope of
switching/scaling/migration in future."

## Consequences
- Free tiers have real limits (connection counts, storage, uptime
  guarantees on some providers) — acceptable for a demo, called out
  explicitly so it's never mistaken for a production-ready deployment.
- No infrastructure-as-code (Terraform) is written until Phase 4 is
  actually undertaken; Phase 1.5's free-tier setup is expected to be
  configured manually/via each provider's dashboard, documented in
  `infra-strategy.md` rather than codified, since it may change providers
  before Phase 4 is ever reached.
