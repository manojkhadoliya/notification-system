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

**NotificationRequest**
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| tenant_id | uuid | id-reference |
| recipient_id | uuid | id-reference |
| idempotency_key | text | unique per (tenant_id, idempotency_key) |
| channel | enum | requested channel |
| payload | jsonb | channel-specific content |
| status | enum | accepted \| queued \| dispatched \| delivered \| failed |
| created_at | timestamptz | |

**DeliveryAttempt**
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| notification_request_id | uuid | fk → NotificationRequest (same context) |
| attempt_number | int | |
| status | enum | sent \| failed \| delivered |
| provider_response | jsonb nullable | raw provider response for debugging |
| created_at | timestamptz | |

**Outbox**
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| notification_request_id | uuid | fk → NotificationRequest |
| published | boolean | flipped by the outbox relay once sent to the broker |
| created_at | timestamptz | |

Written in the **same DB transaction** as `NotificationRequest` — this is
the transactional outbox pattern, guaranteeing the API never persists a
request without an eventual broker publish, even across a crash.

## Templates (Phase 2)

**Template** / **TemplateVersion** — versioned per-channel content,
referenced from `NotificationRequest.payload` by id, not detailed further
until Phase 2.

## Notes

- All timestamps are `timestamptz` (UTC).
- Each bounded context is expected to live in its own Prisma schema module
  under `infra-postgres`, even though Phase 1 runs them against a single
  physical Postgres database — this keeps the option open to split into
  separate databases later without touching domain code.
