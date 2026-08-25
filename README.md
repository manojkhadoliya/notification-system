# Notification System

A multi-channel notification platform (SMS, Push, Email, In-app) built as a
portfolio project to demonstrate distributed-systems design: async delivery
via message queues, retries with dead-letter handling, multi-tenancy, rate
limiting, and a Domain-Driven Design / hexagonal architecture that keeps
business logic decoupled from infrastructure choices.

**Status:** architecture and documentation phase. No application code yet —
see [`docs/roadmap.md`](docs/roadmap.md) for the build plan.

## Start here

- [`docs/architecture/high-level-design.md`](docs/architecture/high-level-design.md)
  — **start here**: requirements, capacity estimation, high-level
  architecture, and key decisions, end to end in one read
- [`docs/architecture/overview.md`](docs/architecture/overview.md) — detailed
  system diagram and component responsibilities
- [`docs/architecture/domain-model.md`](docs/architecture/domain-model.md) —
  bounded contexts and ubiquitous language
- [`docs/architecture/data-model.md`](docs/architecture/data-model.md) —
  entities and relationships
- [`docs/architecture/api-spec.md`](docs/architecture/api-spec.md) — Phase 1
  HTTP API
- [`docs/architecture/messaging.md`](docs/architecture/messaging.md) —
  queue topology, retry/DLQ design
- [`docs/architecture/multi-tenancy.md`](docs/architecture/multi-tenancy.md)
  — tenant auth, idempotency, rate limiting
- [`docs/architecture/infra-strategy.md`](docs/architecture/infra-strategy.md)
  — local-first / free-tier plan and future migration path
- [`docs/architecture/scaling-strategy.md`](docs/architecture/scaling-strategy.md)
  — how the system absorbs user-count growth without a redesign
- [`docs/adr/`](docs/adr) — architecture decision records
- [`docs/roadmap.md`](docs/roadmap.md) — phased build plan

## Repo layout

`services/` holds every deployable backend process in this system (an HTTP
server and queue-consumer workers) — there is no frontend in this project,
so "service" is used throughout instead of the more ambiguous "app."

```
services/           composition roots (HTTP API, queue workers) — DI wiring only
packages/
  domain-*/          bounded-context domain models + ports, zero infra deps
  infra-*/            adapters implementing domain ports (Postgres, Kafka, Cassandra, Redis)
  providers-*/        adapters for external channel providers (Twilio, FCM, ...)
  shared-kernel/       minimal cross-context value objects
infra/               local infrastructure (docker-compose)
docs/                architecture docs and ADRs
```

Each `services/*` and `packages/*` folder has its own `README.md` describing
its responsibility and which phase brings it to life.

## Tech stack (planned)

Node.js / TypeScript, Fastify, PostgreSQL (Prisma) + Cassandra/ScyllaDB
(polyglot persistence per bounded context, see
[ADR 0008](docs/adr/0008-elastic-scale-data-plane.md)), Kafka, Redis, Docker
Compose for local dev, free-tier hosting for the public demo.
