# Domain Model — Bounded Contexts

This system is organized around Domain-Driven Design: independent bounded
contexts, each with its own model and language, connected through
explicitly defined ports rather than shared database tables or direct
imports.

## Bounded contexts

### Notification Delivery (core domain)
Owns the lifecycle of a send request: accepting it, orchestrating dispatch
across a channel, and recording the outcome. This is the reason the system
exists, so it gets the most design attention (retry policy, circuit
breaking, DLQ).

**Ubiquitous language:**
- **NotificationRequest** — a tenant's request to notify one recipient;
  identified by a tenant-scoped idempotency key. Carries a
  `notificationType`, an optional channel override, and (if it originated
  from a fan-out expansion) a `broadcastId` back-reference.
- **DeliveryAttempt** — one try at delivering a request through one
  channel; has a status (`queued`, `sent`, `failed`, `delivered`) and
  provider response metadata.
- **Channel** — `sms | push | email | in_app`.
- **RetryPolicy** — backoff schedule and max-attempts rule applied before a
  `DeliveryAttempt` is routed to the dead-letter queue.
- **RoutingDecision** — the router's output for one event: resolved
  channel, quiet-hours verdict, and rendered content. Produced once, by
  `services/router`, never recomputed by a worker — see
  [`messaging.md`](messaging.md#router).
- **DedupeClaim** — a conditional claim on `(tenantId,
  notificationRequestId, recipientId, channel)`, taken by a worker
  immediately before the provider call, so an at-least-once redelivery
  never repeats a send. See
  [ADR 0010](../adr/0010-delivery-reliability.md) — this is a correctness
  invariant, not a tunable.
- **ScheduledNotification** — a deferred `NotificationRequest`, held for a
  quiet-hours window or a future send, keyed by `due_at`. See
  [ADR 0011](../adr/0011-scheduling-and-fanout.md).
- **BroadcastRequest** / **Chunk** — a broadcast's audience descriptor, and
  the work-sized groups `services/fanout-expander` splits it into before
  expanding to individual `NotificationRequest`s. Door 2 only — see
  [`messaging.md`](messaging.md#broadcast-is-door-2-only).

**Ports it defines** (implemented by infrastructure packages):
- `NotificationRepository` — persist/query requests and attempts (read
  model only as of [ADR 0009](../adr/0009-event-backbone-router.md) —
  nothing on the delivery path reads through it).
- `MessageBroker` — publish an event/command for async dispatch; the
  router and workers consume through this port too.
- `DedupeRepository` — claim a `DedupeClaim` before a provider call.
- `ScheduledNotificationRepository` — write/claim `ScheduledNotification`
  rows (`due_at` range queries — see
  [`data-model.md`](data-model.md#scheduled_notifications)).
- `SmsGateway` / `PushGateway` / `EmailGateway` / `InAppGateway` — send
  through a concrete channel provider (per
  [ADR 0004](../adr/0004-channel-rollout.md), all four are built
  together, not phased).

### Recipient Preferences
Owns who can be contacted, how, and when.

**Ubiquitous language:**
- **Recipient** — a tenant's end user, with channel addresses (phone
  number, push token).
- **Preference** — per recipient/channel/notification-type opt-in or
  opt-out. **Deferred extension point:** channel fallback ("SMS bounced,
  try push") is scoped as a per-`notificationType` ordered channel list on
  `Preference`, resolved by the router — decided as a design shape, not yet
  built; see [`../roadmap.md`](../roadmap.md#future-work).
- **QuietHours** — a time window during which non-urgent notifications are
  suppressed. Enforced by the router, which defers into
  `ScheduledNotification` rather than dropping — see
  [`messaging.md`](messaging.md#router).
- **Consent** — the record that a recipient agreed to receive a channel of
  notification (compliance-relevant).
- **RecipientKey** — a per-recipient encryption key used to protect
  personal-data fields on the long-retention event log; destroying it is
  how an erasure request is honored without editing the log itself. See
  [`data-privacy.md`](data-privacy.md) — designed now, build deferred.

**Ports it defines:**
- `PreferenceRepository` — read/write recipient preferences and quiet
  hours.
- `RecipientKeyRepository` — get/create/destroy a recipient's encryption
  key. See [`data-privacy.md`](data-privacy.md).

### Identity & Tenancy
Owns tenant isolation and access control.

**Ubiquitous language:**
- **Tenant** — an isolated customer of the platform.
- **ApiKey** — credential a tenant uses to call the API, scoped to a
  tenant.
- **RateLimitPolicy** — per-tenant, per-channel request budget.

**Ports it defines:**
- `TenantRepository`, `ApiKeyRepository`.
- `RateLimiter` — enforce `RateLimitPolicy` (implemented via Redis).

### Templates
Owns versioned, per-channel message content.

**Ubiquitous language:**
- **Template** — a named, tenant-owned, per-channel message definition.
- **TemplateVersion** — an immutable, locale-specific rendering of a
  `Template`; a `NotificationRequest` references a specific version by id,
  never "the latest," so edits never change the content of an
  already-sent request's history.
- **Locale**.

**Ports it defines:**
- `TemplateRepository` — read/write templates and their versions.

## Context map

```
 Identity & Tenancy ──(tenantId)──▶ Notification Delivery
                                          │
                    (recipientId)        │  (templateVersionId, optional)
                          ▼               ▼
                 Recipient Preferences   Templates
```

Contexts reference each other **by id only** — never by foreign-key join or
shared table. `Notification Delivery` asks `Recipient Preferences`
(through its port) whether a send is allowed before dispatching; it does
not read the preferences table directly.

`services/router` is a `Notification Delivery` composition root, not a
fifth context — it makes exactly the decisions this context map already
assigns to `Notification Delivery` (which channel, whether to defer) and
`Recipient Preferences` (opt-out, quiet hours), just centralized in one
process instead of repeated inside every worker. See
[`messaging.md`](messaging.md#router).

## Rule: dependency direction

```
services/*  ──depends on──▶  domain-*  (ports + entities)
                                  ▲
infra-*, providers-*  ──implements──┘
```

- `domain-*` packages import nothing from `infra-*` or `providers-*`.
- `infra-*` / `providers-*` packages import a `domain-*` package to
  implement its port interfaces.
- `services/*` packages are composition roots: they import both a domain
  package and the infra/provider adapters that implement its ports, and
  wire them together (dependency injection) at startup.

This is enforced going forward with a lint rule / dependency-cruiser config
in Phase 0, so the boundary can't silently erode as the codebase grows.

**Corollary: infra choice is per-context, not system-wide.** Because each
context owns its own port and repository, different contexts are free to
be backed by different storage technology, chosen for that context's own
access pattern — nothing requires one database for the whole system. This
is applied in practice in [ADR 0003](../adr/0003-polyglot-persistence.md):
`domain-notification` is backed by Kafka + Cassandra (its write-heavy,
id-keyed hot path), while `domain-identity`/`domain-preferences`/
`domain-templates` stay on Postgres.

## Where does new logic belong?

The dependency-direction rule says *imports* aren't allowed to cross the
`services/*` → `domain-*` ← `infra-*`/`providers-*` boundary the wrong way.
It doesn't by itself tell you which side a new piece of logic belongs on.
Use this test:

> **If it would change because a business rule changed, it belongs in
> `domain-*`. If it would only change because a technology choice changed,
> it belongs in `infra-*`/`providers-*`. `services/*` shouldn't need to
> change for either reason** — only when a new endpoint/queue is added or
> the DI wiring changes.

| Question | Where it's answered | Why |
|---|---|---|
| "Is this tenant within its SMS rate limit right now?" | `domain-notification`'s dispatch service asks the `RateLimiter` port | The *decision to check*, and what to do on failure (retry vs. reject), is business logic. The Redis token-bucket mechanics behind the port are infra. |
| "Should this recipient be skipped for quiet hours?" | `domain-preferences` | Pure domain rule |
| "How many times do we retry before DLQ?" | `RetryPolicy` in `domain-notification` | Business policy, not a broker setting |
| "Parse the queue message, look up the request, call dispatch()" | `services/worker-sms` | Mechanical glue — no decision-making |
| "What table does `DeliveryAttempt` live in?" | `infra-postgres` | Infra detail, invisible to domain |

A `services/*` composition root that starts making decisions (branching on
a business condition rather than just wiring/routing) is a sign logic
leaked out of `domain-*` and needs to move back.
