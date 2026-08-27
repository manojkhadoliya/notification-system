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

**Depends on:** Redis pub/sub (via `infra-redis`). No domain repository
ports — connection routing is mechanical, not a business decision; the
"should this recipient see this" decision already happened in
`services/router` before the message reached `command.in_app`.

**Delivered in:** Phase 1. Design and rationale in
[ADR 0012](../../docs/adr/0012-inapp-gateway-split.md).
