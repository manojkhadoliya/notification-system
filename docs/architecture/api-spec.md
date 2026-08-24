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

**Response — 409 Conflict** — idempotency key already used for a different
payload within the dedup window.

**Response — 429 Too Many Requests** — tenant/channel rate limit exceeded.

## `GET /v1/notifications/:id`

Fetch current status and delivery-attempt history for a request.

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
