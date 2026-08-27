# ADR 0006: Local-first infrastructure, hosted deployment deferred

## Status
In Progress

## Context
This is an unfunded portfolio project — no ongoing cloud spend is
acceptable — but it should still demonstrate infrastructure judgment
appropriate to a system that might later need to scale.

## Decision
The full local-only build (see [ADR 0004](0004-channel-rollout.md)) runs
entirely on local Docker Compose: PostgreSQL, Kafka, and Redis, plus every
`services/*` process. **No Cassandra container in Phase 1** — per
[ADR 0003](0003-polyglot-persistence.md) (revised), notification-delivery's
read model runs on Postgres until a measured threshold is crossed; see
[`scaling-strategy.md`](../architecture/scaling-strategy.md#storage-phasing).
A hosted free-tier demo on wire-compatible managed services, and a paid,
scaled AWS deployment, are both documented as future work but deliberately
left unphased and uncommitted — channel breadth and deployment target are
separate decisions, and only the former is committed to now. Full detail:
[`infra-strategy.md`](../architecture/infra-strategy.md).

## Rationale
Every piece of infrastructure is used via its vanilla open protocol
(Postgres wire protocol, the Kafka protocol, the Redis protocol — and,
later, the Cassandra protocol once that store is adopted) rather than a
proprietary managed API — combined with the ports-and-adapters structure
from [ADR 0005](0005-ddd-hexagonal-architecture.md), this means both the
eventual move to hosted infrastructure and the eventual Cassandra adoption
are configuration/adapter changes, not an application rewrite.

## Consequences
- A single-node/single-broker local setup proves the pipeline is *correct*
  end to end. It doesn't demonstrate scale-out under real load — that would
  need real infrastructure to load-test, which stays out of scope for now.
  See [`scaling-strategy.md`](../architecture/scaling-strategy.md).
- No infrastructure-as-code (Terraform) is written until the paid-cloud
  future work is actually undertaken; the hosted free-tier demo's setup is
  expected to be configured manually/via each provider's dashboard,
  documented in `infra-strategy.md` rather than codified, since it may
  change providers before that future work is ever reached.
- Free tiers, when adopted, have real limits (connection counts, storage,
  uptime guarantees) — worth calling out explicitly whenever that step is
  taken, so it's never mistaken for a production-ready deployment.
