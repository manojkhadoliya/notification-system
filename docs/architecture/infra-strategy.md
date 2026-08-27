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
  postgres   (official image — domain-identity, domain-preferences,
              domain-templates, and — Phase 1 — domain-notification's
              read model too; Cassandra deferred, see
              scaling-strategy.md#storage-phasing and ADR 0003 revised)
  redis      (official image — rate limiting, idempotency, the
              read-through cache in front of postgres, and pub/sub for
              worker-inapp <-> inapp-gateway)
  kafka      (official image, KRaft mode — no separate Zookeeper needed)
  jaeger     (all-in-one image, OTLP/HTTP receiver — trace backend for
              packages/observability's startTracing(); UI on :16686)
  api, router, scheduler, fanout-expander,
  worker-sms, worker-push, worker-email, worker-inapp, inapp-gateway,
  projection-notification (built from this repo, once each has a
              Dockerfile — Phase 1; the Phase 0 compose file brings up
              only the four infra containers above)
```

No `cassandra` service in Phase 1 — `infra-cassandra`'s port shape is
reserved (see [`overview.md`](overview.md#components)) but the adapter and
container are only added once a threshold in
[`scaling-strategy.md`](scaling-strategy.md#storage-phasing) is actually
crossed, not before.

PgBouncer (connection pooling — see
[`scaling-strategy.md`](scaling-strategy.md#keeping-postgres-off-the-hot-path))
isn't in the local compose stack: it's a scale lever with nothing to prove
at single-developer local volume, the same reasoning
[ADR 0002](../adr/0002-message-broker-kafka.md) already applies to Kafka
partition counts. It's added when the hosted/scaled deployment actually
needs it, not before.

Zero external accounts, zero cost, fastest iteration loop. This proves the
pipeline is *correct* end-to-end — a single-broker, single-node local setup
does not, by itself, demonstrate the peak-throughput scale-out
[ADR 0002](../adr/0002-message-broker-kafka.md) and
[`scaling-strategy.md`](scaling-strategy.md) are about; that needs real
infrastructure to load-test, which stays out of scope here. This is the
environment all Phase 1 development and testing targets.

## Future work (not phased) — hosted free-tier demo

Deferred per [ADR 0004](../adr/0004-channel-rollout.md) — channel
breadth (all four channels, Phase 1) and deployment target (local vs.
hosted) are separate decisions, and only the former is committed to right
now. When this is picked up: same containers/services, moved to free tiers
chosen specifically because each has a clear, well-trodden upgrade path to
a paid/scaled equivalent:

| Concern | Free tier (future) | Scaled equivalent (further future) | Migration effort |
|---|---|---|---|
| Compute | Fly.io / Railway free tier | AWS ECS Fargate | redeploy container image, no code change |
| Postgres (identity, preferences, templates) | Supabase or Neon free tier | AWS RDS (+ PgBouncer/RDS Proxy) | connection string swap (both are vanilla Postgres) |
| Broker (notification delivery) | Upstash Kafka or Confluent Cloud free tier | Confluent Cloud (dedicated) / Amazon MSK | connection string + credentials swap (both speak the Kafka protocol) |
| Wide-column store (notification delivery, once adopted — see [`scaling-strategy.md`](scaling-strategy.md#storage-phasing)) | DataStax Astra DB free tier | Astra DB (paid) / self-hosted Scylla cluster | connection string swap (Astra is managed Cassandra) |
| Cache | Upstash free tier | AWS ElastiCache | connection string swap (both are Redis-compatible) |
| Tracing | Grafana Cloud / Honeycomb free tier | Same (or self-managed Tempo) | endpoint swap (both speak OTLP, same as local Jaeger) |

Because every one of these is used via its vanilla open protocol (not a
proprietary managed API), most of this table is genuinely just an
environment variable change — the adapter code in `infra-postgres` /
`infra-kafka` / `infra-cassandra` / `infra-redis` doesn't need to change,
only its connection config. The `SmsGateway`/`PushGateway` ports keep the
same pattern for providers: a `mock` adapter is used by default so the whole
system runs and is testable without any provider account, and a real
Twilio/FCM adapter is swapped in via config once credentials exist.

## Future work (not phased) — paid cloud scale-out

If this ever needed to be a real production system: Terraform for AWS (ECS
Fargate, RDS for the Postgres-backed contexts, ElastiCache, Amazon MSK or a
self-managed Kafka cluster, and either Amazon Keyspaces or a self-managed
Scylla cluster for the notification-delivery read model), documented as a
future option in [`../roadmap.md`](../roadmap.md) but explicitly out of
scope for the portfolio build. This is also where partition
counts/consumer-group sizing would actually be tuned against a real load
test — the mechanism [ADR 0002](../adr/0002-message-broker-kafka.md)'s
scale-out story depends on. The point of the ports/adapters investment made
in Phase 1 is that this phase would be infrastructure work, not an
application rewrite.

See [ADR 0006](../adr/0006-local-first-free-tier-infra.md),
[ADR 0002](../adr/0002-message-broker-kafka.md), and
[ADR 0003](../adr/0003-polyglot-persistence.md) for the decision records,
and [`scaling-strategy.md`](scaling-strategy.md) for the
user-growth curve this whole document's migration path is sized against.
