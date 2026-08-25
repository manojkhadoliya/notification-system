# API Spec — Phase 1

Base path: `/v1`. Auth: `Authorization: Bearer <api-key>` (tenant-scoped,
validated against `ApiKey` in the Identity & Tenancy context).

## `POST /v1/notifications`

Accept a notification request for async dispatch.

**Headers**
- `Authorization: Bearer <api-key>` (required)
- `Idempotency-Key: <string>` (required) — deduplicated per tenant via the
  `IdempotencyStore` port before persisting.

**Request body**
```json
{
  "recipientId": "uuid",
  "channel": "sms | push | email | in_app",
  "templateVersionId": "uuid (optional)",
  "payload": {
    "message": "string"
  }
}
```
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
`202` means the request was durably produced to Kafka (after
application-level dedup on `tenantId` + `idempotencyKey`), not that it's
been written to a queryable store yet — see the note on
`GET /v1/notifications/:id` below and
[ADR 0008](../adr/0008-notification-delivery-cqrs.md).

**Response — 409 Conflict** — idempotency key already used for a different
payload within the dedup window.

**Response — 429 Too Many Requests** — tenant/channel rate limit exceeded.

## `GET /v1/notifications/:id`

Fetch current status and delivery-attempt history for a request, read from
the Cassandra-backed projection populated by
`services/projection-notification`. **Eventually consistent** with the
Kafka log, not transactional: a `GET` issued immediately after a `202` may
return `404` for a brief window until the projection consumer catches up.
Clients that need to confirm acceptance synchronously should treat `202`
itself as that confirmation, not a subsequent `GET`.

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
