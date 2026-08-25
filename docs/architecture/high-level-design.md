# High-Level Design

Read this first. It's the whole system end to end at a summary level;
everything it references (domain model, data model, messaging topology,
ADRs) is the detailed backup for whichever section you want to go deeper
on.

## 1. Problem statement

A multi-tenant platform that accepts a notification request over HTTP and
reliably delivers it through one of four channels (SMS, Push, Email,
In-app), tracking delivery status and respecting each recipient's
preferences — built to demonstrate that user-count growth (illustratively,
~100 users at launch to on the order of 1,000,000 over 3-4 years) is
absorbed by adding infrastructure capacity, never by redesigning the
system. See [`scaling-strategy.md`](scaling-strategy.md) for the full
growth story this constraint drives.

## 2. Functional requirements

- Accept a notification request (`POST /v1/notifications`), tenant-
  authenticated, idempotent under client retries.
- Respect recipient preferences: channel opt-in/out, quiet hours.
- Deliver reliably: retry with backoff, dead-letter after max attempts.
- Track and query delivery status per request.
- Support template-driven content, versioned so edits don't retroactively
  change already-sent requests.
- In-app feed: list, read, unread count.
- Isolate tenants: one tenant's data, rate limits, and traffic never affect
  another's.

Full endpoint list: [`api-spec.md`](api-spec.md). Full entity/ubiquitous
language: [`domain-model.md`](domain-model.md).

## 3. Non-functional requirements

| Concern | Target | Why / trade-off |
|---|---|---|
| Scale | Absorb ~100 → ~1,000,000 users over 3-4 years via infra capacity only | See [`scaling-strategy.md`](scaling-strategy.md) — this is the primary design constraint, not raw throughput |
| Delivery guarantee | At-least-once, never silently duplicated | Kafka's at-least-once default + idempotent consumers + client-facing `Idempotency-Key` (see [`multi-tenancy.md`](multi-tenancy.md)) |
| Consistency | Eventually consistent status reads | A `GET` right after `202 Accepted` may briefly 404 until the projection catches up — accepted trade-off, see [ADR 0008](../adr/0008-notification-delivery-cqrs.md) |
| Ingest latency | Fast — a stateless API call + a broker produce, not a synchronous DB write | Actual delivery latency is dominated by the provider round-trip (Twilio/FCM/SES), outside this system's control |
| Availability | No formal SLA — this is a portfolio project, not a production service | The data-plane (Kafka/Cassandra) is horizontally scalable and has no single point of failure once clustered; `domain-identity`/`domain-preferences`/`domain-templates` run on a single Postgres instance — an accepted, documented trade-off (see [ADR 0003](../adr/0003-polyglot-persistence.md)), not gold-plated with HA until the lower-volume contexts actually need it |
| Multi-tenancy | Shared, pooled infrastructure; per-tenant rate limits and data isolation | Pooled model is what lets growth be absorbed by adding capacity to shared infra rather than provisioning per tenant — see [`multi-tenancy.md`](multi-tenancy.md) |

## 4. Capacity estimation (illustrative — order of magnitude, not a commitment)

Using the growth curve from [`scaling-strategy.md`](scaling-strategy.md):

| | Launch | Target horizon (~3-4 yrs) |
|---|---|---|
| Users (recipients) | ~100 | ~1,000,000 |
| Peak notifications/sec | <10 | ~1,000 (industry ballpark, not a hard target) |
| Notifications/day at peak-ish sustained rate | negligible | ~50-80M (illustrative, at a few hundred/sec average) |

**Storage, back-of-envelope:** each notification produces one
`NotificationRequest` row + 1-2 `DeliveryAttempt` rows in Cassandra, roughly
1-2 KB combined (payload + metadata + provider response). At an illustrative
sustained average in the low hundreds/sec, that's on the order of tens of
GB/day of new data at the target horizon. Cassandra absorbs this by adding
nodes (a capacity lever, not a redesign — see
[`scaling-strategy.md`](scaling-strategy.md)), but unbounded growth is still
a cost problem worth a policy: see the retention/TTL note in
[`data-model.md`](data-model.md#notes).

**Read:write ratio** differs sharply by context, which is *why* the
architecture is polyglot rather than one database for everything:
notification-delivery is closer to 1:1 (each request is written once, read
maybe once via `GET .../:id`) and write-heavy in aggregate; identity/
preferences are read-heavy relative to writes (checked on every dispatch,
edited rarely) — which is exactly why those reads are pulled onto Redis via
a cache in front of Postgres rather than left to scale linearly with
dispatch volume (see [`scaling-strategy.md`](scaling-strategy.md#keeping-postgres-off-the-hot-path)).

## 5. High-level architecture

```
                          ┌─────────────────────┐
   Client / API  ───────▶ │   services/api        │  auth + idempotency +
   consumer               │   (Fastify)            │  rate-limit checked here
                          └──────────┬─────────────┘
                                     │ produce (recipientId-keyed)
                                     ▼
                          ┌─────────────────────┐
                          │        Kafka           │  durable log of record
                          │  (per-channel topics,  │  (no outbox — see ADR 0008)
                          │   retry tiers, DLQ)    │
                          └──────────┬─────────────┘
                     ┌───────────────┼───────────────┐
                     ▼               ▼               ▼
             ┌───────────┐   ┌───────────┐   ┌──────────────┐
             │  Workers    │   │ Projection  │   │  (identity /   │
             │ (per channel│   │  consumer   │   │   preferences /│
             │  dispatch)  │   │             │   │   templates —  │
             └──────┬──────┘   └──────┬──────┘   │   Postgres,     │
                    ▼                 ▼          │   Redis-cached) │
             ┌───────────┐   ┌───────────────┐   └──────────────┘
             │  Provider   │   │   Cassandra    │        ▲
             │ (Twilio/FCM/│   │ (status + feed │        │ read on every
             │  SES/socket)│   │   read model)  │        │ dispatch/request
             └───────────┘   └───────────────┘◀──────────┘
                                     ▲
                                     │ GET /v1/notifications/:id,
                                     │ GET /v1/feed/:recipientId
                              (back to services/api)
```

This is the simplified view. The exact topic/partition/consumer-group
layout is in [`messaging.md`](messaging.md); the exact component-to-port
map is in [`overview.md`](overview.md); the full per-entity schema is in
[`data-model.md`](data-model.md).

## 6. API design (summary)

| Endpoint | Purpose |
|---|---|
| `POST /v1/notifications` | Accept a request; `202` means durably logged to Kafka |
| `GET /v1/notifications/:id` | Status + attempt history (eventually consistent) |
| `GET/PUT /v1/preferences/:recipientId` | Opt-in/out, quiet hours |
| `POST /v1/templates`, `POST /v1/templates/:id/versions`, `GET /v1/templates/:id` | Template management |
| `GET /v1/feed/:recipientId`, `POST /v1/feed/:recipientId/:id/read` | In-app feed |
| `POST /v1/webhooks/twilio` | Delivery confirmation callback |

Full request/response shapes: [`api-spec.md`](api-spec.md).

## 7. Data model (summary)

Four bounded contexts, each owning its own tables, referenced across
contexts by id only (never a join) — see
[`domain-model.md`](domain-model.md) for the context map.

| Context | Store | Key entities |
|---|---|---|
| Notification Delivery | Kafka (write) + Cassandra (read) | NotificationRequest, DeliveryAttempt, NotificationFeedItem |
| Recipient Preferences | Postgres | Recipient, Preference |
| Identity & Tenancy | Postgres | Tenant, ApiKey |
| Templates | Postgres | Template, TemplateVersion |

Full schema: [`data-model.md`](data-model.md).

## 8. Key design decisions

| Decision | Choice | One-line why | Record |
|---|---|---|---|
| Architecture pattern | DDD + hexagonal (ports/adapters) | Domain logic never depends on infra; infra is swappable behind ports | [ADR 0005](../adr/0005-ddd-hexagonal-architecture.md) |
| Monorepo tooling | pnpm workspaces | Strict linking blocks phantom cross-package imports, reinforcing the DDD boundary at install time | [ADR 0001](../adr/0001-monorepo-structure.md) |
| HTTP framework | Fastify, long-lived process | Async-native, plugin-scoped encapsulation matches bounded contexts, no Lambda cold-start/connection-pool fight | [ADR 0007](../adr/0007-http-framework-fastify.md) |
| Channel rollout | All four channels together, one local-only phase | Gateway ports were already additive; no de-risking benefit left to phasing | [ADR 0004](../adr/0004-channel-rollout.md) |
| Message broker | Kafka | A partitioned log scales dispatch by adding partitions/consumers, not by redesigning the broker | [ADR 0002](../adr/0002-message-broker-kafka.md) |
| Datastores | PostgreSQL (identity/preferences/templates) + Cassandra (notification-delivery), chosen per context | Each context's own access pattern decides its store; nothing requires one database system-wide | [ADR 0003](../adr/0003-polyglot-persistence.md) |
| Notification-delivery data flow | CQRS: Kafka is the write/event log, Cassandra is the read projection | No dual-write coordination problem; read and write scale independently | [ADR 0008](../adr/0008-notification-delivery-cqrs.md) |
| Kafka partition key | `recipientId`, not `tenantId` | A tenant-keyed partition caps one large tenant's throughput regardless of partition count | [`scaling-strategy.md`](scaling-strategy.md#why-the-kafka-partition-key-is-recipientid-not-tenantid) |
| Deployment target | Local Docker Compose now; hosted demo/paid-cloud deferred, unphased | Channel breadth and deployment target are separate axes; only the former is committed to | [ADR 0006](../adr/0006-local-first-free-tier-infra.md) |

## 9. Bottlenecks, trade-offs, and known limitations

Stated plainly rather than glossed over:

- **Eventual consistency window** on status reads — a `GET` immediately
  after `202 Accepted` can briefly 404. Mitigated (idempotent, QUORUM-
  consistent projection), not eliminated.
- **Redis hot-key risk** for one extreme-volume tenant's rate-limit
  counter — identified mitigation (sharded sub-buckets), not built, because
  no current tenant profile demands it.
- **No retention policy sized yet** for the Cassandra tables — flagged in
  [`data-model.md`](data-model.md#notes), not yet a specific TTL number.
- **Single Postgres instance** for identity/preferences/templates — correct
  at the designed scale (see capacity estimation above), would need a read
  replica or managed HA only if those specific contexts' *read* volume ever
  outgrew what Redis caching absorbs, which isn't expected from notification
  volume growth alone.
- **Real provider throughput ceilings** (Twilio, FCM, SES) are far below
  anything this system's architecture is concerned with — a partnerships/
  multi-account problem, not a software one.

## 10. Future work

Not phased, not committed to — see [`roadmap.md`](../roadmap.md#future-work-not-phased--introduce-later-if-needed):
hosted free-tier demo, paid-cloud scale-out.
