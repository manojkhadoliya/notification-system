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
| fallback_order | text[] nullable | ordered channel list for this notification_type, e.g. `[push, sms]` — **deferred**, see [`domain-model.md`](domain-model.md#recipient-preferences); column reserved, not read by the router yet |

**RecipientKey** — see [`data-privacy.md`](data-privacy.md) for the full
design. **Designed now, build deferred** — not part of the Phase 1 schema,
listed here so its ownership (this context) and shape are visible next to
`Recipient`.
| field | type | notes |
|---|---|---|
| recipient_id | uuid | pk, fk → Recipient |
| data_key_ciphertext | bytea | envelope-encrypted per-recipient key |
| created_at | timestamptz | |
| destroyed_at | timestamptz nullable | erasure marker |

## Notification Delivery (core domain)

Per [ADR 0008](../adr/0008-notification-delivery-cqrs.md), this context's
data model is CQRS-shaped: Kafka (see [`messaging.md`](messaging.md)) is
the write/event side and the durable log of record; the tables below are
the **read-model projection**. Per
[ADR 0003](../adr/0003-polyglot-persistence.md) (revised) and
[`scaling-strategy.md`](scaling-strategy.md#storage-phasing), this
projection is **Postgres for Phase 1**, behind the same
`NotificationRepository` port a Cassandra/ScyllaDB adapter would
implement later — moving is a connection-string change at a stated
write-volume threshold, not a rewrite. There is no `Outbox` table — Kafka's
own replication is the durability guarantee, so there's no second write to
reconcile.

**NotificationRequest** (Postgres pk: `id`; Cassandra partition key: `id`, if/when moved)
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| tenant_id | uuid | id-reference |
| recipient_id | uuid | id-reference |
| notification_type | text | what the router checks preferences/fallback against |
| idempotency_key | text | ingest-time dedup happens earlier, via `IdempotencyStore` (Redis), before this row is projected |
| channel | enum | resolved channel (router's decision, or the caller's honored override) |
| broadcast_id | uuid nullable | id-reference back to the originating `BroadcastRequest`, set only for fan-out-expanded requests |
| payload | jsonb-equivalent | rendered content, as published on `command.*` — see [`messaging.md`](messaging.md#self-contained-command-payload) |
| status | enum | accepted \| sent \| delivered \| failed — written **only** by `services/projection-notification`, in that order, never backwards. See [ADR 0010](../adr/0010-delivery-reliability.md#single-writer-status). |
| created_at | timestamptz | |

**DeliveryAttempt** (Postgres pk: `(notification_request_id, attempt_number)`; Cassandra partition key: `notification_request_id`, clustering key: `attempt_number`, if/when moved)
| field | type | notes |
|---|---|---|
| notification_request_id | uuid | id-reference — "all attempts for this request" |
| attempt_number | int | |
| status | enum | sent \| failed \| delivered |
| provider_response | text/blob nullable | raw provider response for debugging |
| created_at | timestamptz | |

**DedupeClaim** — see [`messaging.md`](messaging.md#dedupe-claim-before-the-provider-call). Postgres unique constraint for Phase 1; moves to a partitioned KV store (Scylla / DynamoDB-style conditional write) past the threshold in [`scaling-strategy.md`](scaling-strategy.md#storage-phasing).
| field | type | notes |
|---|---|---|
| tenant_id | uuid | part of the unique key — see [ADR 0010](../adr/0010-delivery-reliability.md) |
| notification_request_id | uuid | part of the unique key |
| recipient_id | uuid | part of the unique key |
| channel | enum | part of the unique key |
| claimed_at | timestamptz | |

`(tenant_id, notification_request_id, recipient_id, channel)` is a unique
constraint, not just an index — the claim *is* the insert; a conflicting
insert means "already claimed," which is how the worker knows not to call
the provider again.

**ScheduledNotification** — see
[`messaging.md`](messaging.md#router) and
[ADR 0011](../adr/0011-scheduling-and-fanout.md). Stays on Postgres
permanently (see [`scaling-strategy.md`](scaling-strategy.md#storage-phasing))
— it needs range queries on `due_at` that a log isn't built to answer.
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| tenant_id | uuid | id-reference |
| recipient_id | uuid | id-reference |
| notification_type | text | |
| channel | enum nullable | override, if the original event specified one |
| template_version_id | uuid nullable | |
| payload | jsonb | template variables or raw content, carried through to the re-emitted event |
| priority | enum | critical \| standard \| bulk |
| due_at | timestamptz | when the poller should re-emit this |
| due_minute | int | derived from `due_at`, used to shard poller claims — see [ADR 0011](../adr/0011-scheduling-and-fanout.md) |
| status | enum | pending \| claimed \| emitted |
| claimed_at | timestamptz nullable | set by `SELECT ... FOR UPDATE SKIP LOCKED` when a poller shard claims the row |
| created_at | timestamptz | |

`GET /v1/notifications/:id` reads the `NotificationRequest`/`DeliveryAttempt`
projection directly by id — fast, but eventually consistent with the Kafka
log (see ADR 0008's consistency trade-off). The projection consumer upserts
idempotently, so at-least-once redelivery from Kafka never produces
duplicate rows, and its ordered state machine means redelivery can't
regress `status` either.

**NotificationFeedItem** (Postgres: partial index on `(recipient_id, read_at)`; Cassandra partition key: `recipient_id`, clustering key: `created_at desc`, if/when moved) — `in_app` channel only
| field | type | notes |
|---|---|---|
| recipient_id | uuid | "the feed" is a query by this key, not a table scan |
| created_at | timestamptz | descending, for "most recent first" |
| notification_request_id | uuid | id-reference back to `NotificationRequest` |
| summary | text | short rendered preview for the feed list |
| read_at | timestamptz nullable | set when the recipient marks the item read |

A `notification_request_id`-keyed table can't efficiently answer "all
unread items for this recipient" — access patterns have to be modeled as
their own key, which matters even more once this table moves to Cassandra
(no ad-hoc query support there at all). `NotificationFeedItem` is a second
projection off `command.in_app` (populated by `services/worker-inapp`, not
`services/projection-notification`, since it's `in_app`-specific — see
[`messaging.md`](messaging.md#in-app-is-structurally-different)), the same
CQRS pattern [ADR 0008](../adr/0008-notification-delivery-cqrs.md) already
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

- All timestamps are `timestamptz` (UTC); a future Cassandra-backed move
  would use the store's native timestamp type instead.
- `Identity & Tenancy`, `Recipient Preferences`, `Templates`, and — for
  Phase 1 — `Notification Delivery`'s read model
  (`NotificationRequest`/`DeliveryAttempt`/`DedupeClaim`/
  `ScheduledNotification`/`NotificationFeedItem`) all live in their own
  Prisma schema module under `infra-postgres`, sharing one physical
  Postgres database. `Notification Delivery` is still the one context
  whose *write* side (Kafka) is on different physical infrastructure from
  the rest — the read-model store is what's deferred, per
  [ADR 0003](../adr/0003-polyglot-persistence.md) (revised) — persistence
  is still chosen per context's access pattern, not a system-wide default;
  it's just that Postgres is the honest answer for that pattern at Phase 1
  volume, and Cassandra becomes it later. See
  [`scaling-strategy.md`](scaling-strategy.md#storage-phasing) for the
  thresholds.
- **Retention:** `NotificationRequest`/`DeliveryAttempt`/`NotificationFeedItem`
  grow without bound otherwise. Planned: a TTL/cleanup policy on these
  tables (e.g. 90 days), after which a request's operational history ages
  out; nothing in `domain-notification` depends on old rows existing, so
  this is a config-level policy (a scheduled Postgres delete for Phase 1; a
  native Cassandra TTL if/when that move happens), not a domain change. Not
  yet sized to a specific number — noted here so it isn't silently
  forgotten, per [`high-level-design.md`](high-level-design.md)'s capacity
  estimate.
