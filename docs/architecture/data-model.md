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
| email | text nullable | |
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

**NotificationFeedItem** (partition key: `recipient_id`, clustering key: `created_at desc`) — `in_app` channel only
| field | type | notes |
|---|---|---|
| recipient_id | uuid | partition key — "the feed" is a query by this key, not a table scan |
| created_at | timestamptz | clustering key, descending, for "most recent first" |
| notification_request_id | uuid | id-reference back to `NotificationRequest` |
| summary | text | short rendered preview for the feed list |
| read_at | timestamptz nullable | set when the recipient marks the item read |

A partition-key-by-`notification_request_id` table can't efficiently answer
"all unread items for this recipient" — Cassandra has no ad-hoc query
support, so access patterns have to be modeled as their own partition key.
`NotificationFeedItem` is a second projection off the same Kafka event
stream (populated by `services/worker-inapp`, not
`services/projection-notification`, since it's `in_app`-specific), the same
CQRS pattern [ADR 0008](../adr/0008-elastic-scale-data-plane.md) already
established for `NotificationRequest`/`DeliveryAttempt`.

## Templates

**Template**
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| tenant_id | uuid | id-reference to Identity & Tenancy |
| name | text | unique per tenant |
| channel | enum | sms \| push \| email \| in_app |
| created_at | timestamptz | |

**TemplateVersion**
| field | type | notes |
|---|---|---|
| id | uuid | pk — this is what `NotificationRequest.payload` references, never `Template.id` directly |
| template_id | uuid | fk → Template (same context) |
| locale | text | e.g. `en-US` |
| version | int | monotonically increasing per template |
| content | text | Handlebars source |
| created_at | timestamptz | |

`TemplateVersion` rows are immutable once created — publishing an edit
creates a new version rather than mutating an existing one, so a
`NotificationRequest` that referenced a version keeps rendering identically
even after the template is later edited.

## Notes

- All timestamps are `timestamptz` (UTC), except in the Cassandra-backed
  Notification Delivery tables, which use the store's native timestamp type.
- `Identity & Tenancy`, `Recipient Preferences`, and `Templates` each live in
  their own Prisma schema module under `infra-postgres`, sharing one
  physical Postgres database in Phase 1 — this keeps the option open to
  split into separate databases later without touching domain code.
  `Notification Delivery` is
  the one context that already lives on different physical infrastructure
  (Kafka + Cassandra via `infra-kafka`/`infra-cassandra`), per
  [ADR 0008](../adr/0008-elastic-scale-data-plane.md) — polyglot persistence
  chosen per context's access pattern, not a system-wide default.
