# Infra Strategy — Local-First, Free-Tier, Migration-Ready

## Constraint

This is a portfolio project: no ongoing cloud spend is acceptable, but the
design should read as production-minded — i.e. it should be obvious how it
*would* scale, without actually paying to prove it.

## The mechanism: ports and adapters

Every piece of infrastructure (database, broker, cache, external provider)
is accessed by domain/application code only through a port interface
defined in a `domain-*` package (see
[`domain-model.md`](domain-model.md)). Concrete infrastructure lives in
`infra-*` / `providers-*` packages that implement those ports, and gets
wired in at the composition root (`services/*`) via configuration. Swapping an
implementation — a different Postgres host, a different broker, a
different SMS provider — means writing or selecting a new adapter and
changing wiring/env vars. It never means touching `domain-*` code.

## Phase 1 — fully local

```
docker-compose.yml runs:
  postgres   (official image — domain-identity, domain-preferences)
  cassandra  (official image, single node — domain-notification read model)
  redis      (official image)
  kafka      (official image, KRaft mode — no separate Zookeeper needed)
  api, worker-sms, worker-push (built from this repo)
```

Zero external accounts, zero cost, fastest iteration loop. This proves the
pipeline is *correct* end-to-end (see
[ADR 0008](../adr/0008-elastic-scale-data-plane.md)) — a single-broker,
single-node local setup does not, by itself, demonstrate the peak-throughput
scale-out that decision is about; that needs real infrastructure to
load-test, which stays out of scope here. This is the environment all
Phase 1 development and testing targets.

## Phase 1.5 — hosted free-tier demo

Same containers/services, moved to free tiers chosen specifically because
each has a clear, well-trodden upgrade path to a paid/scaled equivalent:

| Concern | Free tier (Phase 1.5) | Scaled equivalent (future) | Migration effort |
|---|---|---|---|
| Compute | Fly.io / Railway free tier | AWS ECS Fargate | redeploy container image, no code change |
| Postgres (identity, preferences) | Supabase or Neon free tier | AWS RDS | connection string swap (both are vanilla Postgres) |
| Broker (notification delivery) | Upstash Kafka or Confluent Cloud free tier | Confluent Cloud (dedicated) / Amazon MSK | connection string + credentials swap (both speak the Kafka protocol) |
| Wide-column store (notification delivery) | DataStax Astra DB free tier | Astra DB (paid) / self-hosted Scylla cluster | connection string swap (Astra is managed Cassandra) |
| Cache | Upstash free tier | AWS ElastiCache | connection string swap (both are Redis-compatible) |

Because every one of these is used via its vanilla open protocol (not a
proprietary managed API), most of this table is genuinely just an
environment variable change — the adapter code in `infra-postgres` /
`infra-kafka` / `infra-cassandra` / `infra-redis` doesn't need to change,
only its connection config. The `SmsGateway`/`PushGateway` ports keep the
same pattern for providers: a `mock` adapter is used by default so the whole
system runs and is testable without any provider account, and a real
Twilio/FCM adapter is swapped in via config once credentials exist.

## Phase 4 (optional, not built) — paid cloud scale-out

If this ever needed to be a real production system: Terraform for AWS (ECS
Fargate, RDS for the Postgres-backed contexts, ElastiCache, Amazon MSK or a
self-managed Kafka cluster, and either Amazon Keyspaces or a self-managed
Scylla cluster for the notification-delivery read model), documented as a
future option in [`../roadmap.md`](../roadmap.md) but explicitly out of
scope for the portfolio build. This is also where partition
counts/consumer-group sizing would actually be tuned against a real load
test — the mechanism ADR 0008's elastic peak-handling story depends on. The
point of the ports/adapters investment made in Phase 1 is that this phase
would be infrastructure work, not an application rewrite.

See [ADR 0006](../adr/0006-local-first-free-tier-infra.md) and
[ADR 0008](../adr/0008-elastic-scale-data-plane.md) for the decision
records.
