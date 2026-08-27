# Data Privacy — Erasure Against the Event Log

**Status: designed, build deferred.** This document describes the
mechanism; [`../roadmap.md`](../roadmap.md) schedules it as future work,
not part of the Phase 1 build. It's written now, ahead of the build,
because retrofitting an encryption boundary onto an already-running event
log is much more expensive than designing the boundary before the first
message is produced.

## The problem

[`messaging.md`](messaging.md#self-contained-command-payload) keeps
`events.*` payload **by reference** — ids and template variable
keys/values, not rendered content — specifically to keep the long-retention
log's PII footprint small. That narrows the problem; it doesn't close it.
A `recipientId` and template variables like `orderId`, `amount`, or a
recipient's name are still personal data, and they still sit in an
immutable, long-retention Kafka log. Deleting a row in Postgres or
Cassandra on an erasure request is straightforward. Deleting one message
out of a replicated, offset-addressed log is not what the log is built to
do — durability is exactly the property that makes selective forgetting
hard.

## The mechanism: per-recipient crypto-shredding

Encrypt the personal-data fields of `events.*` payload
(`payloadRef.vars`) with a key that's unique per recipient, generated when
the recipient is first created and stored separately from the event log.
An erasure request destroys that key. Every message already on the log
that referenced it becomes permanently unreadable — the ciphertext is
still there, but nothing can turn it back into personal data — without
touching Kafka at all.

```
 Recipient created ──▶ RecipientKey generated, stored in recipient_keys

 Router / producer library, before publish:
   encrypt(payloadRef.vars, recipientKey) ──▶ events.*  (ciphertext only)

 Router, at render time (and any consumer reading payload off the backbone):
   decrypt(payloadRef.vars, recipientKey)
     succeeds ──▶ render / read normally
     key destroyed ──▶ fail closed (see "Fail-closed behavior" below)

 Erasure request ──▶ destroy_key(recipientId)  ──▶ every past and future
                                                     decrypt attempt for
                                                     that recipient fails
```

## Ownership

`RecipientKey` is owned by the Recipient Preferences context — it's a
property of the `Recipient` entity, not of any individual notification.

**RecipientKey**
| field | type | notes |
|---|---|---|
| recipient_id | uuid | pk, fk → `Recipient` |
| data_key_ciphertext | bytea | the per-recipient key, itself encrypted at rest under a master key (envelope encryption) |
| created_at | timestamptz | |
| destroyed_at | timestamptz nullable | erasure marker — once set, `data_key_ciphertext` is overwritten, not just flagged |

New port on `domain-preferences`: `RecipientKeyRepository` —
`get(recipientId)`, `create(recipientId)`, `destroy(recipientId)`.
Implemented by `infra-postgres`, same physical database as `Recipient`
(see [`data-model.md`](data-model.md)).

**Local dev vs. hosted:** in Phase 1 (local-only, per
[ADR 0006](../adr/0006-local-first-free-tier-infra.md)), the master key
that wraps each `data_key_ciphertext` is a local config value. A hosted
deployment (see [`infra-strategy.md`](infra-strategy.md)) would wrap it
with a real KMS (AWS KMS / GCP KMS) instead — an adapter-level change
behind the same port, not a domain change, consistent with how every other
storage decision in this system is phased.

## Who encrypts, who decrypts

- **Encrypt:** whichever door produces the event (Door 1's
  `services/api`, or Door 2's producer library) encrypts
  `payloadRef.vars` before the event is published — personal data never
  reaches the Kafka log in plaintext, not even momentarily.
- **Decrypt:** the router, immediately before template rendering (it's the
  one place that needs the raw values). Any future consumer that reads
  payload directly off `events.*` — the audit sink, analytics — decrypts
  on read using the same port, never persists the decrypted value, and is
  subject to the same fail-closed rule below.
- **Never:** `command.*` payload is already rendered plaintext by design
  (see [`messaging.md`](messaging.md#self-contained-command-payload)) —
  encryption only applies to the long-retention backbone, not the
  short-retention command topics, which age out on their own within the
  retry-ladder's timescale regardless.

## Fail-closed behavior

If a recipient's key has been destroyed (erasure already processed) and a
late-arriving or replayed event still references that recipient, decrypt
fails. The router does not fall back to sending with missing/garbled
content — it treats this identically to "recipient not found": the
notification is dropped, logged as `erased`, and never reaches
`command.*`. An erasure request implies the recipient no longer wants to
be reached with data referencing them, so failing closed is the correct
behavior, not an edge case to work around.

## What this doesn't solve

- **Non-payload fields** — `recipientId` itself, `tenantId`,
  `notificationType`, timestamps — stay in the clear on the log; they're
  identifiers and metadata, not the personal-data payload this mechanism
  targets. Whether `recipientId` alone counts as personal data under a
  given compliance regime is a legal question, not an architecture one;
  flagged here so it isn't silently assumed settled.
- **Retention policy** on `events.*` itself is unsized — the same gap
  noted for the Cassandra-backed tables in
  [`data-model.md`](data-model.md#notes). Crypto-shredding makes an
  unbounded retention *survivable* from a privacy standpoint; it isn't a
  substitute for eventually setting one.
- **Backups / replicated copies** of the key store need their own erasure
  story (a destroyed key must actually be gone from every replica and
  backup, not just the primary) — out of scope for this document, noted so
  it isn't forgotten when the key store is actually built.
