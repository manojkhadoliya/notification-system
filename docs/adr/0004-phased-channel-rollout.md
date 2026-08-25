# ADR 0004: All four channels built together, single local-only phase

## Status
Accepted (supersedes the original SMS+Push-first phased rollout — see
"Alternatives considered")

## Context
The system's scope is four channels: SMS, Push, Email, In-app. The original
version of this ADR phased them — SMS+Push first, Email/In-app deferred to
a "Phase 2" — to get a working end-to-end demo sooner and de-risk the
DDD/hexagonal structure before committing to it across the whole surface
area. Revisiting that: the value of an intermediate two-channel milestone is
lower than having one complete, working local demo, and the channel/gateway
port pattern this system is built around (see
[ADR 0005](0005-ddd-hexagonal-architecture.md)) was already designed so
adding a channel is additive, not a restructuring — so there's less
de-risking benefit to phasing than the original ADR assumed.

## Decision
Build all four channels — SMS, Push, Email, In-app — together, as one
local-only build. There is no separate SMS+Push-first phase and no deferred
Email/In-app phase. This is orthogonal to *deployment target*: everything
still runs on local Docker Compose only (per [ADR 0006](0006-local-first-free-tier-infra.md)).
A hosted free-tier demo and any paid-cloud scale-out remain deferred and
unphased — not committed to now, to be introduced later if needed. Channel
breadth and deployment target are two separate axes; only channel breadth
is being expanded by this decision.

## Rationale
- The `Channel` enum and gateway ports (`SmsGateway`/`PushGateway`/
  `EmailGateway`/`InAppGateway`) were already designed as additive per-channel
  extension points — building all four now is more surface area in one pass,
  not a structurally riskier change than building two.
- Email introduces the Templates bounded context; In-app introduces a
  stateful WebSocket gateway and a read/unread feed model. Both are real,
  separately-scoped additions, but neither requires revisiting the core
  dispatch/retry/DLQ machinery SMS and Push already exercise — they plug
  into the same `domain-notification` dispatch orchestration via a new
  gateway port each.
- Keeping the deployment target unchanged (local-only) means this decision
  doesn't also force a hosting decision — the added scope is contained to
  what already runs in `docker compose up`.

## Alternatives considered
- **Original decision: SMS+Push first, Email/In-app in a later phase.** Real
  value — smaller surface area to validate the DDD boundaries against
  before committing further, and a working demo sooner. Superseded because
  the boundaries are now considered proven enough (see ADR 0005's
  Consequences) that the incremental-validation benefit no longer outweighs
  having one complete build instead of two milestones.

## Consequences
- `domain-templates`, `providers-email`, `services/worker-email`, and
  `services/worker-inapp` move from future/deferred stubs to in-scope now —
  new package/service READMEs added, and `docs/roadmap.md`'s phase
  structure collapses accordingly (single "Phase 1" covers the full local
  build; hosted-demo/paid-cloud move to an unphased "Future work" section).
- `api-spec.md`, `data-model.md`, `domain-model.md`, `messaging.md`, and
  `overview.md` updated to document Email/In-app/Templates as current scope
  rather than "Phase 2."
- More upfront build surface before there's any working demo at all —
  accepted as the direct consequence of this decision; there is no
  intermediate two-channel milestone anymore.
