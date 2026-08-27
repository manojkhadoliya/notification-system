# ADR 0013: Data erasure via per-recipient crypto-shredding

## Status
Proposed — designed now, build deferred (not part of the Phase 1 roadmap;
see [`../roadmap.md`](../roadmap.md))

## Context
[`messaging.md`](../architecture/messaging.md#self-contained-command-payload)
keeps `events.*` payload by reference (ids + template variable
keys/values, not rendered content) specifically to keep the long-retention
log's PII footprint small. That narrows the erasure problem; it doesn't
close it — a `recipientId` and template variable values (order ids,
amounts, names) are still personal data sitting in an immutable,
replicated, offset-addressed Kafka log. Deleting a row in a database on an
erasure request is straightforward; deleting one message out of a log
built specifically to not lose messages is not what the log is designed to
do.

This is written and decided now, ahead of Phase 1, because retrofitting an
encryption boundary onto an event log that's already carrying production
traffic is materially more expensive than designing the boundary before
the first message is produced — every consumer that ever reads payload off
the backbone has to be built against the boundary from the start, or
migrated later at real cost.

## Decision
Encrypt the personal-data fields of `events.*` payload
(`payloadRef.vars`) with a key unique to each recipient
(`RecipientKey`, owned by the Recipient Preferences context — see
[`data-privacy.md`](../architecture/data-privacy.md) for the full
mechanism and schema), generated when the recipient is created and stored
separately from the event log. An erasure request destroys that key.
Every message already on the log that referenced it becomes permanently
unreadable, without touching Kafka.

Whichever door produces an event (Door 1's `services/api`, or Door 2's
producer library) encrypts before publishing — personal data never reaches
the log in plaintext, not even momentarily. The router decrypts
immediately before template rendering, the one point that needs the raw
values; any future consumer reading payload directly off `events.*`
(audit, analytics) decrypts on read through the same port and never
persists the decrypted value. If a key has been destroyed, decryption
fails and the router treats it identically to "recipient not found" —
fails closed, doesn't send with missing or garbled content.

**Explicitly deferred:** the build itself. This ADR fixes the shape (key
ownership, encrypt/decrypt boundary, fail-closed behavior) so it's ready to
implement without a redesign, but no code ships against it in Phase 1 — see
"Consequences" below for what that implies about scope.

## Rationale
- **Destroying a key is provably permanent; editing a log is not.**
  Kafka's replication and retention exist specifically to make messages
  hard to lose — using that same log as the erasure target fights the
  system's own design goal. Making the *key* the thing that's deleted,
  rather than the message, means erasure works with the log's durability
  instead of against it.
- **Encrypt at the edge, not at the router.** Encrypting in the router
  (rather than at each door) would mean personal data crosses the network
  and briefly exists in plaintext in the router's memory before the first
  encrypted write — a smaller window than "in the log forever," but a real
  one. Encrypting at the door that first has the data closes that window
  entirely.
- **Fail closed, not fail soft.** An erasure request is a statement that
  the recipient doesn't want to be reached using data referencing them.
  Silently sending with placeholder content, or crashing, are both worse
  than simply not sending and logging why.
- **Design now, build later is itself a deliberate choice, not
  procrastination.** The mechanism is fully specified — schema, ports, key
  lifecycle, fail-closed behavior — precisely so that when it is built,
  it's implementing an already-agreed design, not deciding one under
  pressure from a real erasure request or a compliance deadline.

## Alternatives considered
- **Payload-by-reference alone, no encryption (the status quo before this
  ADR).** Reduces the PII footprint but doesn't solve erasure — ids and
  variable values are still personal data, still permanently on the log.
- **Field-level redaction on request (rewrite/compact the log).** Doesn't
  fit an offset-addressed, replicated log; compaction changes what
  "replay" means for every other consumer and isn't a targeted per-
  recipient operation.
- **Build the full mechanism in Phase 1.** Real scope addition — a new key
  store, encrypt-on-publish in both doors, decrypt-on-read (fail-closed) in
  every consumer that touches payload off the backbone — before any of the
  seven Phase 1 items in [ADR 0009](0009-event-backbone-router.md)/
  [0010](0010-delivery-reliability.md)/[0011](0011-scheduling-and-fanout.md)/
  [0012](0012-inapp-gateway-split.md) have even shipped. Rejected for
  Phase 1 specifically to keep that scope focused; the design work happens
  now so the eventual build isn't starting from zero.

## Consequences
- New table: `recipient_keys`, owned by Recipient Preferences — see
  [`data-model.md`](../architecture/data-model.md#recipient-preferences).
- New port: `RecipientKeyRepository` (`domain-preferences`) — see
  [`domain-model.md`](../architecture/domain-model.md).
- Not scheduled in Phase 1 — see
  [`../roadmap.md`](../roadmap.md#future-work). Until built, `events.*`
  payload remains unencrypted and this system has no answer to an erasure
  request against the log; that gap is explicit, not silently assumed
  solved by payload-by-reference alone.
- When built, every consumer that reads `events.*` payload directly
  (currently: the router; in the future: any audit/analytics sink) must
  decrypt through `RecipientKeyRepository` and implement the fail-closed
  behavior above — this is a contract on future consumers, not just the
  first one.
