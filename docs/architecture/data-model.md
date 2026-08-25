# Data Model

Entities are grouped by the bounded context that owns them (see
[`domain-model.md`](domain-model.md)). Cross-context references are by id
only — no cross-context foreign keys, so each context's tables could be
split into their own database later without a redesign.

## Identity & Tenancy

**Tenant**
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| name | text | |
| created_at | timestamptz | |

**ApiKey**
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| tenant_id | uuid | fk → Tenant |
| hashed_key | text | never store raw key |
| created_at | timestamptz | |
| revoked_at | timestamptz nullable | |

## Recipient Preferences

**Recipient**
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| tenant_id | uuid | id-reference to Identity & Tenancy, not a joined FK across contexts |
| phone | text nullable | |
| push_token | text nullable | |
| email | text nullable | (Phase 2) |
| created_at | timestamptz | |

**Preference**
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| recipient_id | uuid | fk → Recipient (same context) |
| channel | enum | sms \| push \| email \| in_app |
| notification_type | text | e.g. "billing", "marketing" |
| opted_in | boolean | |
| quiet_hours_start | time nullable | |
| quiet_hours_end | time nullable | |

## Notification Delivery (core domain)

Per [ADR 0008](../adr/0008-elastic-scale-data-plane.md), this context's
data model is CQRS-shaped: Kafka (`sms.notify`/`push.notify` topics, see
[`messaging.md`](messaging.md)) is the write/event side and the durable log
of record; the tables below are the **read-model projection**, stored in a
wide-column store (Cassandra/ScyllaDB via `infra-cassandra`), partitioned by
id for the write-heavy, join-free access pattern this context has. There is
no `Outbox` table — Kafka's own replication is the durability guarantee, so
there's no second write to reconcile.

**NotificationRequest** (partition key: `id`)
| field | type | notes |
|---|---|---|
| id | uuid | partition key |
| tenant_id | uuid | id-reference |
| recipient_id | uuid | id-reference |
| idempotency_key | text | dedup happens earlier, via `IdempotencyStore` (Redis), before this row is projected |
| channel | enum | requested channel |
| payload | jsonb-equivalent | channel-specific content |
| status | enum | accepted \| queued \| dispatched \| delivered \| failed |
| created_at | timestamptz | |

**DeliveryAttempt** (partition key: `notification_request_id`, clustering key: `attempt_number`)
| field | type | notes |
|---|---|---|
| notification_request_id | uuid | partition key — same-partition reads for "all attempts for this request," no join needed |
| attempt_number | int | clustering key |
| status | enum | sent \| failed \| delivered |
| provider_response | text/blob nullable | raw provider response for debugging |
| created_at | timestamptz | |

`GET /v1/notifications/:id` reads this projection directly by partition key
— fast, but eventually consistent with the Kafka log (see ADR 0008's
consistency trade-off). Projection consumers upsert idempotently, so
at-least-once redelivery from Kafka never produces duplicate rows.

## Templates (Phase 2)

**Template** / **TemplateVersion** — versioned per-channel content,
referenced from `NotificationRequest.payload` by id, not detailed further
until Phase 2.

## Notes

- All timestamps are `timestamptz` (UTC), except in the Cassandra-backed
  Notification Delivery tables, which use the store's native timestamp type.
- `Identity & Tenancy` and `Recipient Preferences` each live in their own
  Prisma schema module under `infra-postgres`, sharing one physical Postgres
  database in Phase 1 — this keeps the option open to split into separate
  databases later without touching domain code. `Notification Delivery` is
  the one context that already lives on different physical infrastructure
  (Kafka + Cassandra via `infra-kafka`/`infra-cassandra`), per
  [ADR 0008](../adr/0008-elastic-scale-data-plane.md) — polyglot persistence
  chosen per context's access pattern, not a system-wide default.
