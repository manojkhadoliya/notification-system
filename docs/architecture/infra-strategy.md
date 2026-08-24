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
wired in at the composition root (`apps/*`) via configuration. Swapping an
implementation — a different Postgres host, a different broker, a
different SMS provider — means writing or selecting a new adapter and
changing wiring/env vars. It never means touching `domain-*` code.

## Phase 1 — fully local

```
docker-compose.yml runs:
  postgres   (official image)
  redis      (official image)
  rabbitmq   (official image, management plugin enabled)
  api, worker-sms, worker-push (built from this repo)
```

Zero external accounts, zero cost, fastest iteration loop. This is the
environment all Phase 1 development and testing targets.

## Phase 1.5 — hosted free-tier demo

Same containers/services, moved to free tiers chosen specifically because
each has a clear, well-trodden upgrade path to a paid/scaled equivalent:

| Concern | Free tier (Phase 1.5) | Scaled equivalent (future) | Migration effort |
|---|---|---|---|
| Compute | Fly.io / Railway free tier | AWS ECS Fargate | redeploy container image, no code change |
| Postgres | Supabase or Neon free tier | AWS RDS | connection string swap (both are vanilla Postgres) |
| Broker | CloudAMQP free ("Lemur") tier | Amazon MQ (RabbitMQ) | connection string swap (both are RabbitMQ) |
| Cache | Upstash free tier | AWS ElastiCache | connection string swap (both are Redis-compatible) |

Because Postgres/RabbitMQ/Redis are used as their vanilla open-source
protocols (not a proprietary managed API), most of this table is genuinely
just an environment variable change — the adapter code in `infra-postgres`
/ `infra-rabbitmq` / `infra-redis` doesn't need to change, only its
connection config. The `SmsGateway`/`PushGateway` ports keep the same
pattern for providers: a `mock` adapter is used by default so the whole
system runs and is testable without any provider account, and a real
Twilio/FCM adapter is swapped in via config once credentials exist.

## Phase 4 (optional, not built) — paid cloud scale-out

If this ever needed to be a real production system: Terraform for AWS (ECS
Fargate, RDS, ElastiCache, Amazon MQ), documented as a future option in
[`../roadmap.md`](../roadmap.md) but explicitly out of scope for the
portfolio build. The point of the ports/adapters investment made in Phase 1
is that this phase would be infrastructure work, not an application
rewrite.

See [ADR 0006](../adr/0006-local-first-free-tier-infra.md) for the decision
record.
