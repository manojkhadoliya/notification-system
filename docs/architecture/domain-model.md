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
- **NotificationRequest** — a tenant's request to notify a recipient
  through one or more channels; identified by a tenant-scoped idempotency
  key.
- **DeliveryAttempt** — one try at delivering a request through one
  channel; has a status (`queued`, `sent`, `failed`, `delivered`) and
  provider response metadata.
- **Channel** — `sms | push | email | in_app`.
- **RetryPolicy** — backoff schedule and max-attempts rule applied before a
  `DeliveryAttempt` is routed to the dead-letter queue.

**Ports it defines** (implemented by infrastructure packages):
- `NotificationRepository` — persist/query requests and attempts.
- `MessageBroker` — publish a request for async dispatch; workers consume
  through this port too.
- `SmsGateway` / `PushGateway` (later `EmailGateway`, `InAppGateway`) —
  send through a concrete channel provider.

### Recipient Preferences
Owns who can be contacted, how, and when.

**Ubiquitous language:**
- **Recipient** — a tenant's end user, with channel addresses (phone
  number, push token).
- **Preference** — per recipient/channel/notification-type opt-in or
  opt-out.
- **QuietHours** — a time window during which non-urgent notifications are
  suppressed.
- **Consent** — the record that a recipient agreed to receive a channel of
  notification (compliance-relevant).

**Ports it defines:**
- `PreferenceRepository` — read/write recipient preferences and quiet
  hours.

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

### Templates (Phase 2)
Owns versioned, per-channel message content.

**Ubiquitous language:**
- **Template**, **TemplateVersion**, **Locale**.

## Context map

```
 Identity & Tenancy ──(tenantId)──▶ Notification Delivery
                                          │
                    (recipientId)        │  (templateId, Phase 2)
                          ▼               ▼
                 Recipient Preferences   Templates
```

Contexts reference each other **by id only** — never by foreign-key join or
shared table. `Notification Delivery` asks `Recipient Preferences`
(through its port) whether a send is allowed before dispatching; it does
not read the preferences table directly.

## Rule: dependency direction

```
apps/*  ──depends on──▶  domain-*  (ports + entities)
                              ▲
infra-*, providers-*  ──implements──┘
```

- `domain-*` packages import nothing from `infra-*` or `providers-*`.
- `infra-*` / `providers-*` packages import a `domain-*` package to
  implement its port interfaces.
- `apps/*` packages are composition roots: they import both a domain
  package and the infra/provider adapters that implement its ports, and
  wire them together (dependency injection) at startup.

This is enforced going forward with a lint rule / dependency-cruiser config
in Phase 0, so the boundary can't silently erode as the codebase grows.
