# API Spec — Phase 1

Base path: `/v1`. Auth: `Authorization: Bearer <api-key>` (tenant-scoped,
validated against `ApiKey` in the Identity & Tenancy context).

This is Door 1 of the two-door ingress described in
[`messaging.md`](messaging.md#two-doors-onto-one-backbone) — the
tenant-facing HTTP API. Internal services have a second door (a producer
library, no HTTP hop) for domain facts; both normalize onto the same event
shape before anything downstream sees them.

## `POST /v1/notifications`

Accept a notification **intent** for async dispatch — the caller states who
and why, not necessarily which channel; that's the router's decision (see
[`messaging.md`](messaging.md#router)), unless overridden explicitly.

**Headers**
- `Authorization: Bearer <api-key>` (required)
- `Idempotency-Key: <string>` (required) — deduplicated per tenant via the
  `IdempotencyStore` port before persisting.

**Request body**
```json
{
  "recipientId": "uuid",
  "notificationType": "string",
  "channel": "sms | push | email | in_app (optional override)",
  "templateVersionId": "uuid (optional)",
  "payload": {
    "message": "string"
  }
}
```
`recipientId` is a single recipient — this door doesn't accept an audience
descriptor. Broadcast to many recipients goes through Door 2 only; see
[`messaging.md`](messaging.md#broadcast-is-door-2-only). `notificationType`
is required — it's what the router checks preferences against when
`channel` is omitted. If `channel` is present, it's honored as a
*requested* channel, still checked against that recipient's opt-out for
that channel/notification-type — not a bypass of the preference check.
`payload` is either raw content (as above) or the variables a
`templateVersionId` renders against — one or the other, not both. See
[`domain-model.md`](domain-model.md#templates) for the Templates context.

**Response — 202 Accepted**
```json
{
  "id": "uuid",
  "status": "accepted"
}
```
`202` means the request was durably produced to the event backbone (after
application-level dedup on `tenantId` + `idempotencyKey`), not that it's
been delivered, or even routed to a channel yet — see the note on
`GET /v1/notifications/:id` below and
[ADR 0009](../adr/0009-event-backbone-router.md).

**Response — 409 Conflict** — idempotency key already used for a different
payload within the dedup window.

**Response — 429 Too Many Requests** — tenant/channel rate limit exceeded.

## `GET /v1/notifications/:id`

Fetch current status and delivery-attempt history for a request, read from
the read-model projection populated by `services/projection-notification`
(see [`messaging.md`](messaging.md#delivery-status-has-one-writer)).
**Eventually consistent**, not transactional: a `GET` issued immediately
after a `202` may return `404` for a brief window until the projection
consumer catches up. This has never been anything the delivery path itself
waits on — only this read endpoint does. Clients that need to confirm
acceptance synchronously should treat `202` itself as that confirmation,
not a subsequent `GET`.

**Response — 200 OK**
```json
{
  "id": "uuid",
  "channel": "sms",
  "status": "delivered",
  "attempts": [
    {
      "attemptNumber": 1,
      "status": "failed",
      "createdAt": "2026-08-24T10:00:00Z"
    },
    {
      "attemptNumber": 2,
      "status": "delivered",
      "createdAt": "2026-08-24T10:00:05Z"
    }
  ]
}
```

## `GET /v1/preferences/:recipientId`

Return all channel/notification-type preferences for a recipient.

## `PUT /v1/preferences/:recipientId`

Update opt-in/out and quiet hours for a recipient.

**Request body**
```json
{
  "channel": "sms",
  "notificationType": "billing",
  "optedIn": true,
  "quietHoursStart": "22:00",
  "quietHoursEnd": "07:00"
}
```

## `POST /v1/templates`

Create a template (name + channel). Returns the created `Template`.

## `POST /v1/templates/:id/versions`

Publish a new immutable version of a template.

**Request body**
```json
{
  "locale": "en-US",
  "content": "Hello {{recipientName}}, your order {{orderId}} shipped."
}
```

**Response — 201 Created**
```json
{
  "id": "uuid (this is the templateVersionId used in POST /v1/notifications)",
  "version": 3
}
```

## `GET /v1/templates/:id`

Return a template and its version history.

## `GET /v1/feed/:recipientId`

`in_app` channel only — list feed items, most recent first, from the
`NotificationFeedItem` projection (see
[`data-model.md`](data-model.md#templates)).

**Query params:** `unreadOnly=true` (optional).

## `POST /v1/feed/:recipientId/:notificationRequestId/read`

Mark a feed item read (sets `NotificationFeedItem.read_at`).

## `POST /v1/webhooks/twilio`

Delivery status callback from Twilio, used to move a `DeliveryAttempt` from
`sent` to `delivered` (or `failed`) after the provider confirms out-of-band.
Signature-verified using Twilio's request-signing scheme before being
trusted.

## Error shape (all endpoints)

```json
{
  "error": {
    "code": "string",
    "message": "string"
  }
}
```

## Out of scope

Webhook callbacks for Email/In-app delivery confirmation (only Twilio's is
specified above); admin DLQ-replay endpoint. See
[`../roadmap.md`](../roadmap.md) for what's tracked and when.
