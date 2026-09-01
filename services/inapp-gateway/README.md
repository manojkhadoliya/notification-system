# services/inapp-gateway

Stateless — holds the WebSocket connection registry (which recipient is
connected to which instance) and pushes live in-app notifications.
Subscribes to Redis pub/sub for feed-write notifications from
`services/worker-inapp` and pushes to a recipient's socket if one is open
on this instance. Has **no Kafka consumer-group membership** — that's the
whole point (see
[ADR 0012](../../docs/adr/0012-inapp-gateway-split.md)): connection count
doesn't track dispatch volume, so this process scales on a different axis
than `worker-inapp`, and adding replicas here never triggers a Kafka
rebalance that could interrupt in-flight dispatch elsewhere.

This is the split half of what used to be one `worker-inapp` process — see
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md#in-app-is-structurally-different)
for the full "why" and how the pair fits together with `worker-inapp`.

**Depends on:** Redis pub/sub (via `infra-redis`'s `InAppSubscriber`, on a
connection dedicated to it — `SUBSCRIBE` locks an ioredis connection out
of every other command). No domain repository ports — connection routing
is mechanical, not a business decision; the "should this recipient see
this" decision already happened in `services/router` before the message
reached `command.in_app`.

## How it works

1. A client opens `GET /v1/feed/stream?recipientId=<uuid>` as a WebSocket
   upgrade. `ConnectionRegistry` (`src/connection-registry.ts`) adds the
   socket under that `recipientId` — a recipient can hold more than one
   socket at once (multiple tabs/devices).
2. `InAppSubscriber` (from `infra-redis`) decodes every message published
   on `INAPP_PUBSUB_CHANNEL`. `notify.ts`'s `pushToRegistry` forwards each
   one, JSON-encoded, to every socket this instance holds for that
   `recipientId` — a recipient with no live socket here (none at all, or
   held by a different replica) is silently a no-op; the
   `NotificationFeedItem` row `worker-inapp` already wrote is the durable
   delivery, this is a best-effort live nudge on top of it.
3. On socket close/error, the registry entry is removed.

`ConnectionRegistry`/`notify.ts`/`server.ts`'s routing logic are unit
tested (20 tests) — `server.ts`'s own tests open real loopback WebSocket
connections against an ephemeral port (there's no Fastify-`.inject()`
equivalent for a raw `ws` upgrade), which is still fully in-process and
not "live infra": no Docker, no network beyond localhost.

## Known Phase 1 gap: no connection authentication

**This is a real, deliberately-flagged gap, not an oversight.** The
`?recipientId=<uuid>` query param is trusted as-is — this service performs
no verification that the caller actually is that recipient. Concretely:
anyone who can reach this service's port and knows (or guesses) a
recipient's UUID can open a socket and read that recipient's live in-app
notifications as they're pushed.

Why it's left this way for Phase 1, rather than patched over:

- `domain-identity`'s only auth primitive is a tenant-scoped API key
  (`Authorization: Bearer <api-key>`, used by `services/api`'s Door 1). A
  tenant API key is a **backend secret** — handing it to a browser/mobile
  client so it can authenticate its own WebSocket would be a worse
  mistake than the current gap, not a fix for it.
- Nothing in this system's domain model yet represents a *recipient*-scoped
  session or short-lived signed token an untrusted end-user client could
  safely present. That's new design surface — a token-issuing flow, most
  naturally hung off `services/api` or a BFF in front of it — not
  something to invent unscoped inside this package's `buildServer()`.
- ADR 0012 deliberately keeps this service free of domain repository
  ports ("connection routing is mechanical, not a business decision"), so
  even a same-service fix (e.g. looking up whether `recipientId` belongs
  to the tenant on the caller's API key) would cut against that design.

**Before this service is reachable from anything other than a trusted
internal network or a local dev box, this needs one of:** a signed
short-lived recipient token (minted by `services/api` after whatever
end-user auth the tenant's own app performs, verified here without a
repository lookup — e.g. a JWT this service checks the signature of), or
an authenticating edge/BFF proxy in front of it that only forwards
upgrades for the caller's own verified identity. Neither exists yet;
tracked in `docs/roadmap.md`, not implemented here.

## Local setup

```
pnpm compose:up
pnpm --filter @notification-system/inapp-gateway build
pnpm --filter @notification-system/inapp-gateway start   # reads .env — see .env.example
pnpm --filter @notification-system/inapp-gateway smoke-test
```

`PORT`/`HOST` default to `3001`/`0.0.0.0` (distinct from `services/api`'s
default `3000` purely so both can run locally at once). `REDIS_URL` is
required.

**Not yet run against live Redis** — no Docker in the session this was
built in; `scripts/smoke-test.mjs` is written and ready but unexecuted.
The unit-tested paths (registry fan-out/removal, notification-to-push
bridging, the real loopback WebSocket handshake and push delivery) are
verified; a real Redis pub/sub round-trip through a live process is not.

**Delivered in:** Phase 1. Design and rationale in
[ADR 0012](../../docs/adr/0012-inapp-gateway-split.md).
