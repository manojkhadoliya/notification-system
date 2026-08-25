# ADR 0006: Local-first, free-tier infrastructure

## Status
Accepted. The local-first/free-tier *principle* below still holds; the
specific component list in "Decision" is updated by
[ADR 0008](0008-elastic-scale-data-plane.md) (Kafka + Cassandra replace
RabbitMQ for the notification-delivery hot path) — see that ADR for why,
and [`infra-strategy.md`](../architecture/infra-strategy.md) for the
current component/free-tier table.

## Context
This is an unfunded portfolio project — no ongoing cloud spend is
acceptable — but it should still demonstrate infrastructure judgment
appropriate to a system that might later need to scale.

## Decision
Phase 1 — the single, full-channel build (see
[ADR 0004](0004-phased-channel-rollout.md)) — runs entirely on local Docker
Compose. A hosted free-tier demo on wire-compatible managed services, and a
paid, scaled AWS deployment (Terraform), are both documented as future work
but deliberately left unphased/uncommitted per ADR 0004 — channel breadth
and deployment target are separate decisions. Full detail in
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
- No infrastructure-as-code (Terraform) is written until the paid-cloud
  future work is actually undertaken; the hosted free-tier demo's setup is
  expected to be configured manually/via each provider's dashboard,
  documented in `infra-strategy.md` rather than codified, since it may
  change providers before that future work is ever reached.
