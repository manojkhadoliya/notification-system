# ADR 0004: Phased channel rollout — SMS + Push first

## Status
Accepted

## Context
The system's eventual scope is four channels: SMS, Push, Email, In-app.
Building all four at once would delay having any working end-to-end demo
and would make it harder to validate the DDD/hexagonal structure before
committing to it across the whole surface area.

## Decision
Phase 1 implements SMS and Push only, end-to-end (ingest → queue → worker →
provider → status). Email and In-app (with a WebSocket feed) are added in
Phase 2, once the Phase 1 pipeline and its DDD boundaries have proven out.

## Rationale
- SMS and Push are both simple, stateless "fire a message at a provider"
  channels — good for validating the core dispatch/retry/DLQ machinery
  without also solving templating (needed more by Email) or a persistent
  feed (needed by In-app).
- Email introduces the Templates bounded context; In-app introduces a
  stateful WebSocket gateway and a "read/unread" feed model. Deferring both
  to Phase 2 keeps Phase 1 focused on the distributed-systems core the
  portfolio project is meant to showcase.

## Consequences
- The `Channel` enum and `SmsGateway`/`PushGateway` ports are designed so
  adding `EmailGateway`/`InAppGateway` in Phase 2 is an additive change
  (new adapter package + new enum value), not a restructuring of
  `domain-notification`.
