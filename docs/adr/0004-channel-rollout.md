# ADR 0004: All four channels built together, single local-only build

## Status
In Progress

## Context
The system's scope is four channels: SMS, Push, Email, In-app. Two
independent questions shape how they get built: how much channel breadth
to build before there's a working demo, and what deployment target to
build against.

## Decision
Build all four channels — SMS, Push, Email, In-app — together, as one
local-only build. There is no staged channel rollout. Deployment target is
a separate axis: everything runs on local Docker Compose only (per
[ADR 0006](0006-local-first-free-tier-infra.md)); a hosted free-tier demo
and any paid-cloud scale-out remain deferred and unphased, to be introduced
later if needed. Only channel breadth is committed to now.

## Rationale
- The `Channel` enum and gateway ports (`SmsGateway`/`PushGateway`/
  `EmailGateway`/`InAppGateway`) are additive per-channel extension points
  (see [ADR 0005](0005-ddd-hexagonal-architecture.md)) — building all four
  is more surface area in one pass, not a structurally riskier change than
  building fewer.
- Email introduces the Templates bounded context; In-app introduces a
  stateful WebSocket gateway and a read/unread feed model. Both are real,
  separately-scoped additions, but neither requires revisiting the core
  dispatch/retry/DLQ machinery SMS and Push already exercise — they plug
  into the same `domain-notification` dispatch orchestration via a new
  gateway port each.
- Keeping the deployment target unchanged (local-only) means expanding
  channel breadth doesn't also force a hosting decision — the added scope
  is contained to what already runs in `docker compose up`.

## Alternatives considered
- **Staged channel rollout** (e.g. SMS+Push first, Email/In-app later):
  smaller surface area to validate the DDD boundaries against before
  committing further, and a working demo sooner. Real value, but the
  channel/gateway port pattern is designed to make each channel additive
  regardless of build order, so the incremental-validation benefit is
  smaller than it would be in a less strictly-layered design — not enough
  to outweigh having one complete build instead of an intermediate
  milestone.

## Consequences
- `domain-templates`, `providers-email`, `services/worker-email`, and
  `services/worker-inapp` are in scope from the start, alongside
  `domain-notification`/`domain-preferences`/`domain-identity` and their
  SMS/Push counterparts.
- More upfront build surface before there's any working demo at all — there
  is no intermediate two-channel milestone.
