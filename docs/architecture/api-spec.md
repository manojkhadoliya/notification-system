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
  "channel": "sms | push",
  "payload": {
    "message": "string"
  }
}
```

**Response — 202 Accepted**
```json
{
  "id": "uuid",
  "status": "accepted"
}
```
`202` means the request was durably produced to Kafka (idempotent producer
keyed on `tenantId` + `idempotencyKey`), not that it's been written to a
queryable store yet — see the note on `GET /v1/notifications/:id` below and
[ADR 0008](../adr/0008-elastic-scale-data-plane.md).

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

## Out of scope for Phase 1

Template endpoints, in-app feed endpoints, and email-specific fields are
added in Phase 2 (see [`../roadmap.md`](../roadmap.md)).
