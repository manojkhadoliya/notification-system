# Hardening the Send API

**Adoption guide addressed to:** `notification-system` (Design B)

**Base:** notification-system (this repo)

**Donor:** notification-system-design (reference architecture)

**Applies to:** Phase 0 / Phase 1, before build starts

**Date:** 2026-08-26

B is the product to build: multi-tenant, templated, DDD-structured. This is the change list that takes it from a working demo to a system that survives its own success — six items it inherits from the other design under review, three it keeps untouched, and a few it should specifically not copy. Phase 0/1 haven't started building yet, so every change here lands before the first line of infrastructure code, not after.

---

## 1. Starting point

B's foundations are the right ones to build on: tenant isolation, hashed API keys, per-tenant rate limits, immutable template versions, and a lint-enforced hexagonal boundary that makes every change below a config swap rather than a rewrite. None of that is touched here.

What B is missing is everything that happens *between* "a request arrived" and "a provider was called": nothing decides whether a recipient should hear from you right now, nothing stops the same message from going out twice, and nothing lets one event reach many recipients. Those gaps come from a single structural choice — the client names the channel and the worker makes every decision alone, after the message is already committed to a topic and projected to a database. Sections 3–4 close that gap by inserting the one component B doesn't have: a router that decides *before* the message reaches a channel topic.

| | |

|---|---|

| **Keep, unmodified** | Tenancy, templates, ports — Identity &amp; Tenancy, Recipient Preferences, Templates, and the domain/infra/services boundary. B's strongest material — see §5. |

| **Insert** | A router, before the channel topics — the single structural change everything else in this report depends on. Decides channel, quiet hours, dedupe key and template — once, in one place. See §3–4. |

| **Defer** | Cassandra — start the hot-path tables on Postgres, behind the port that already exists. Move at a measured threshold, not on day one. See §7. |

---

## 2. One backbone, two doors

B currently has one ingress: `POST /v1/notifications`, one recipient and one explicit channel per call. That's the right shape for a tenant calling from outside. It's the wrong shape for an internal service that just wants to say "this happened" and let the platform decide who hears about it and how — which is most of what triggers a notification in practice (a payment failed, an assignment was graded, an announcement published).

Rather than force both into the same contract, give them two doors onto the same backbone. Downstream of the event topics, there is exactly one code path — same router, same workers, same topics, same guarantees — regardless of which door a message came in through.

```

 DOOR 1 — external tenants                DOOR 2 — internal services

 POST /v1/notifications                   producer library (no HTTP hop)

 tenant-authenticated, idempotent          imports the same MessageBroker

 accepts an INTENT:                        port B already defines

   recipientId | audienceDescriptor

   notificationType (+ optional            emits a domain FACT:

   channel override, optional               eventType, tenantId,

   templateVersionId)                       recipientId | audienceDescriptor,

                                             payload

         │                                          │

         └──────────────────┬───────────────────────┘

                             ▼

              events.{critical|standard|bulk}      ← SHARED BACKBONE

              key: recipientId (chunk events: chunkId)

              same envelope shape from both doors

                             │

                             ▼

                    ROUTER  (new — §3/4)

        tenant + preferences + quiet hours + template

        explicit channel from Door 1 is honored as a request,

        not a bypass — still checked against opt-outs

                             │

                             ▼

              command.{sms|push|email|in_app}

              self-contained rendered payload, key: recipientId

                             │

                    ┌────────┴────────┐

                    ▼                 ▼

              channel workers    projection (read model)

           (dedupe → provider)   status / feed / audit

```

**What this buys B:** the tenant API keeps working exactly as documented in [`api-spec.md`](http://api-spec.md) — `202` semantics, idempotency key, rate limits, all unchanged. Internal services get a lighter-weight path with no HTTP round trip and no channel to guess at, and both feed the same reliability machinery. A tenant that wants "notify this recipient about their order" and a tenant that wants "decide the right channel for this billing event" are both real, common requests, and neither should require a different backend.

**Naming note:** keep B's existing "Command" vs "domain fact" distinction from [`domain-model.md`](http://domain-model.md) exactly as the donor design uses it — Door 1 intents and Door 2 facts both normalize into the same internal event shape before the router sees them; only the router's output onto `command.*` topics is a literal command.

---

## 3. Non-negotiable — fix before Phase 1 ships a worker

Five changes. Each one is a correctness gap in B's current messaging/data-model docs, each has a working answer already written down in the donor design, and each gets more expensive to retrofit the longer real traffic runs through the current shape.

### 01 · Critical — Put the rendered payload in the message, not a lookup

**Current gap:** [`messaging.md`](http://messaging.md) keeps the Kafka envelope "intentionally thin" — the worker loads the full payload from Cassandra via `NotificationRepository`, a row written by a separate consumer group `projection-notification`) on the same topic. Nothing orders the two, and `ADR 0008` already documents that the projection lags. So the design's normal case is a worker reading a payload that hasn't been written yet.

This isn't a rare race — it's the default relationship between two independent consumer groups under any load. It fails closed (the worker can't tell "not projected yet" from "not found," so it retries), and retrying adds load to the exact two components that are already behind. The busier B gets, the more often this fires.

**Inherit** — the router renders the message (template + variables resolved) before publishing to `command.{channel}`. The command topic carries the finished payload. The projection stays, but only as a read model for `GET /v1/notifications/:id` — nothing on the delivery path depends on it anymore.

**Files** — `docs/architecture/[messaging.md](http://messaging.md)`, `docs/adr/[0008-notification-delivery-cqrs.md](http://0008-notification-delivery-cqrs.md)`, `packages/domain-notification`

### 02 · High — Claim a dedupe key in the worker, before the provider call

**Current gap:** B's only idempotency mechanism is the ingest-time `Idempotency-Key` in Redis (~24h TTL) plus the Kafka client's idempotent-producer mode. Neither protects the actual send. A worker that calls Twilio and dies before committing its offset gets redelivered on rebalance — Kafka's at-least-once default guarantees this happens eventually — and sends the SMS a second time. The planned DLQ-replay admin endpoint inherits the same gap: replaying means re-sending.

**Inherit** — a conditional write on `(notificationRequestId, recipientId, channel)`, claimed by the worker immediately before the gateway call, not by the router and not at ingest. Claiming any earlier risks losing the notification permanently if the process dies after claiming but before the command is even published.

**Files** — `docs/architecture/[messaging.md](http://messaging.md)`, `packages/infra-postgres` (new DedupeRepository adapter), `services/worker-*`

### 03 · High — Move preference and quiet-hours checks ahead of the channel topic

**Current gap:** the client names the channel, and the preference check runs in the worker — after the message is authenticated, rate-limited, produced, keyed, and projected. An opted-out recipient's message does every unit of work before it's dropped. Quiet hours is modeled in `domain-preferences` `QuietHours` value object) with no mechanism anywhere to defer to — no scheduler, no `due_at`, nothing. In practice it can only become a silent drop or a retry-ladder trip into the DLQ, neither of which is what "quiet hours" should mean.

This is also where channel fallback becomes possible: "SMS hard-bounced, try push" only makes sense if something decides channels centrally instead of a client picking one per call.

**Inherit** — the router checks `PreferenceRepository` and quiet hours before publishing anything to a channel topic. A quiet-hours hit writes a deferred row instead of dropping or proceeding; a due poller re-emits it later (item 04). An explicit channel from Door 1 is treated as a requested channel, still subject to opt-out.

**Files** — `docs/architecture/[domain-model.md](http://domain-model.md)`, `docs/architecture/[messaging.md](http://messaging.md)`, `packages/domain-notification`, `services/router` (new)

### 04 · High — Add a scheduling store for deferrals, digests, and future sends

**Current gap:** there is no mechanism for "remind me in 3 days," daily/weekly digests, or the quiet-hours deferral item 03 depends on. Holding a delayed message in Kafka for hours or days is fragile — it's not queryable, and a broker isn't built to be a calendar.

**Inherit** — a Postgres table `scheduled_notifications`, keyed by `due_at`) separate from the short-lived Kafka retry ladder — different timescale, different mechanism, don't merge them. A poller claims due rows and re-emits them onto the event backbone. Shard the poller by `(due_minute, bucket)` with jittered `due_at` from the start — the donor design's own single-bucket digest poller is a thundering-herd risk at B's target scale (see §6), so this is one place to do better than the source, not just copy it.

**Files** — `docs/architecture/[data-model.md](http://data-model.md)`, `docs/architecture/[scaling-strategy.md](http://scaling-strategy.md)`, `packages/infra-postgres`, `services/scheduler` (new)

### 05 · High — Give one event many recipients — chunked fan-out

**Current gap:** the API accepts one recipient per request. A tenant announcing to a million recipients means a million authenticated calls, a million idempotency keys, a million Redis writes — from an external client, over the internet. That's the ingest tier and the idempotency store becoming the bottleneck for the single most common high-volume pattern a notification platform sees.

**Inherit** — accept an audience descriptor on either door; a fan-out expander resolves it server-side into work-sized chunks (not user-count-sized — cap by total work, e.g. 200 recipients, not 1,000, since each recipient can fan out to up to 4 channel commands) and re-publishes as individual per-recipient events. **Correction to the source pattern:** key chunk-carrier events by `chunkId`, explicitly, as a documented exception to the recipient-keyed rule everywhere else — a chunk of many recipients cannot honestly be keyed by any single one of them, and the donor design never names this exception even though its own partitioning rule requires it.

**Files** — `docs/architecture/[api-spec.md](http://api-spec.md)`, `docs/architecture/[messaging.md](http://messaging.md)`, `services/fanout-expander` (new)

---

## 4. Fix before load testing — not launch-blocking, but load-bearing

Three more changes. None of these will show up on a single-developer Compose stack with no traffic; all three show up the first time real concurrent load hits the system, which is exactly when they're expensive to diagnose.

### 06 · High — Give delivery status one writer, not two

**Current gap:** the projection consumer writes `status: accepted`; the worker independently writes `sent` and later `delivered`, from a different consumer group, with no ordering between them. Cassandra resolves same-cell writes last-write-wins by timestamp — a lagging projection can write `accepted` with a later wall-clock timestamp than the worker's `delivered`, and the row regresses. "Idempotent upsert" (what `ADR 0008` promises) guards against duplicates, not against going backwards — those are different properties, and only one of them is built.

**Fix** — one consumer group owns every write to `NotificationRequest.status`, consuming both the accept event and the channel workers' outcome events, and applies an ordered state machine `accepted → sent → delivered`, never backwards) rather than a plain upsert. This is a correction to make on top of B's own CQRS pattern, not something to import from elsewhere — the donor design doesn't have this problem because it doesn't have two independent writers to the same field.

**Files** — `docs/adr/[0008-notification-delivery-cqrs.md](http://0008-notification-delivery-cqrs.md)`, `packages/domain-notification`, `services/projection-notification`

### 07 · Medium — Split the in-app worker from the socket registry

**Current gap:** `worker-inapp` both consumes a partitioned Kafka topic and holds the WebSocket connection registry. Those don't share a scaling axis — a recipient's socket lands on whichever node the load balancer picked; their messages land on whichever node owns their partition. [`messaging.md`](http://messaging.md) says the worker "holds the registry" without saying how a consuming node reaches a socket held by a different one. Practically: adding replicas to absorb a connection surge triggers a Kafka rebalance and interrupts in-flight dispatch, coupling connection count to delivery throughput.

**Inherit** — split into a stateless `inapp-gateway` that owns sockets and a `worker-inapp` that only writes the `NotificationFeedItem` projection, connected by Redis pub/sub. Scale each independently.

**Files** — `docs/architecture/[messaging.md](http://messaging.md)`, `docs/architecture/[overview.md](http://overview.md)`, `services/worker-inapp`, `services/inapp-gateway` (new)

### 08 · Medium — Give audit its own consumer group, off the delivery path

**Current gap:** delivery history exists only as the Cassandra projection, planned for a ~90-day TTL. There's no append-only audit stream and no analytics consumer group with independent offsets. Replay is described as "native" because Kafka retains the log, but replaying without item 02's dedupe claim means re-sending, and there's no consumer reading history for anything other than the live status view.

**Inherit** — a dedicated audit consumer group, append-only, reading the event backbone independently of dispatch; an analytics consumer group with its own offsets for delivery-rate aggregation. Neither sits on the path a send depends on — if either lags or dies, notifications still go out.

**Files** — `docs/architecture/[overview.md](http://overview.md)`, `docs/architecture/[data-model.md](http://data-model.md)`, `services/sinks` (new)

---

## 5. Keep exactly as designed

Don't let the size of §3–4 read as "B's foundation is weak." These three are stronger than anything in the donor design, and nothing above touches them.

### K1 — Tenancy, auth, rate limiting

Tenant + hashed API key + per`(tenantId, channel)` token bucket, enforced at both ingest and dispatch. The donor design has none of this — no tenant entity anywhere in its schema. If B ever needs to combine with an internal-fact-style ingress, tenancy is the piece that can't be retrofitted later, so building it first was the right call.

### K2 — Immutable template versions

`TemplateVersion`, referenced by id and never "latest." This is also what makes replay honest for either design: without it, replaying an old event after copy changes silently re-renders with new content. The donor design has no template model at all — take B's as-is.

### K3 — Ports/adapters + the dependency-cruiser boundary

The lint-enforced rule that `domain-*` imports nothing from `infra-*providers-*` is what makes every storage change in §7 a config swap instead of an application rewrite. Every new component this report adds (router, fan-out expander, scheduler, inapp-gateway) should be built as a composition root against existing or new ports — not as a special case that skips the boundary.

---

## 6. Don't inherit these — the donor's own mistakes

The other design isn't a template to copy wholesale. Three specific things in it are worth avoiding, precisely because they'd otherwise look like "the more mature answer" when they're actually its own unfixed problems.

| Donor pattern | Why it's broken there | What B should do instead |

|---|---|---|

| 256 partitions per topic, fixed, "never reopen" | Priced as "a directory and some file handles," but with ~30 topics in that design's own topology it works out to roughly 7,700 partitions on a small cluster — never derived from an actual throughput number, and a real cost in rebalance time and batch efficiency at low volume. | Size partitions per topic against B's own stated growth curve in [`scaling-strategy.md`](http://scaling-strategy.md) (illustrative ~1,000/sec at the 1M-user horizon). A number with headroom, derived from that curve, beats a round number picked for its own sake. |

| Single-bucket digest poller | A default hour (e.g. 9am local) puts every digest recipient's due row inside one minute, polled by one process off one index — explicitly stated to be correct only "below roughly thousands of scheduled rows." | Already corrected in item 04 above: shard the poller and jitter `due_at` at write time, before this becomes a problem rather than after. |

| "Reopen: never" on every locked decision | Two of that design's locked decisions are real correctness invariants (dedupe placement, dedupe key shape) and deserve permanence. The rest — priority-as-separate-topics, no-cell-model — are engineering judgments contingent on load and infra choice, marked with the same finality as the invariants. | In B's own ADR format, reserve "never reopen without new evidence" language for genuine invariants (item 02's claim-before-provider-call is one). Everything else gets a normal `Accepted` status that a future ADR can supersede. |

---

## 7. Storage — start narrow, move at a threshold

B's [`high-level-design.md`](http://high-level-design.md) capacity estimate (1M users → "50-80M notifications/day") implies 26-80 sends per user per day; realistic consumer platforms run 1-5. The honest number is closer to 1-5M/day, roughly 12-60/sec average rather than the ~600-900/sec the stated figure implies. That gap matters because it's the justification for reaching for Cassandra on day one — at the honest number, a single Postgres instance handles the write-heavy tables without strain, and everything in §3-4 is easier to build and debug against a single transactional store first.

None of this argues against Cassandra as a destination — it's the right home for these tables at real volume, and B's own ports make the move a connection-string change, not a rewrite. It argues against paying the operational and consistency cost (see item 06) before the load that justifies it exists.

| Data | Phase 1 | Move when | Moves to |

|---|---|---|---|

| Tenants, API keys, preferences, templates | Postgres | never | Stays — provisioning-rate writes, Redis-cached reads (already B's plan) |

| `scheduled_notifications` (new, item 04) | Postgres | never | Stays — needs range queries on `due_at` a log can't answer |

| Dedupe claims (new, item 02) | Postgres unique constraint | &gt; ~2K claims/sec | Partitioned KV (Scylla / DynamoDB-style conditional write) |

| `NotificationRequest` / `DeliveryAttempt` | Postgres, not Cassandra, for Phase 1 | &gt; ~5K writes/sec sustained | Cassandra/ScyllaDB — exactly as `ADR 0003` already describes, just later |

| `NotificationFeedItem` | Postgres, partial index on unread | &gt; ~50M live rows | Cassandra, partitioned by `recipientId`, clustered `created_at desc` |

&gt; **What this means for `ADR 0003` and `ADR 0008`:** not reversed, deferred. The CQRS shape (Kafka as log, a projection as read model) stays — it's the right pattern. What changes is the read model's backing store for Phase 1, and, per item 01, that the delivery path no longer depends on that projection being caught up.

---

## 8. Where this lands in the existing roadmap

Phase 0 and Phase 1 in [`roadmap.md`](http://roadmap.md) haven't started — every checkbox is open. That's the good case: nothing here is a retrofit, it's an addition to the checklist before the first line of infrastructure code.

| Phase | Add | Depends on |

|---|---|---|

| 0 | Priority event topics `events.critical/.standard/.bulk`) alongside the existing per-channel `.notify` topics | — |

| 0 | Internal producer library (Door 2) — same envelope shape as Door 1's normalized intent | Event topic layout |

| 1 | `services/router` — preferences, quiet hours, template render, publishes self-contained `command.*` messages | domain-preferences, domain-templates, event topics |

| 1 | Dedupe claim table + repository port, wired into every `worker-*` immediately before the gateway call | infra-postgres |

| 1 | `scheduled_notifications` table + `services/scheduler` poller (sharded, jittered from the start) | Router (writes deferral rows) |

| 1 | `services/fanout-expander` — audience descriptor → chunked, per-recipient events, keyed by `chunkId` | Event topics |

| 1 | Single-writer status projection consuming both accept and outcome events, ordered state machine | Router, workers publishing outcomes |

| 1 | Split `worker-inapp` into feed writer + stateless `inapp-gateway`, connected via Redis pub/sub | infra-redis |

| 1 | Audit + analytics consumer groups `services/sinks`), independent offsets | Event topics |

| 1 | `NotificationRequestDeliveryAttemptNotificationFeedItem` land on Postgres for Phase 1 (defer the Cassandra adapter, keep the port) | infra-postgres |

---

## 9. Still open — questions for the team

Not blocking Phase 1. These don't have a clearly-better answer in either design, so they're written as decisions to make deliberately, whenever B is ready to make them — not gaps to feel behind on.

**Q1 — Should Door 1 ever accept an audience descriptor directly, or should broadcast always originate from an internal service via Door 2?**

Both are defensible. Letting an external tenant broadcast directly is more self-service; routing all broadcast through Door 2 keeps the highest-blast-radius operation behind something the platform team controls. Whichever way this goes, the fan-out expander (item 05) works identically either way — the decision is about which door, not the mechanism.

**Q2 — What's the cross-tenant fairness story once one tenant is capable of a large broadcast?**

Per-tenant rate limits cap a tenant against itself. They don't stop one tenant's broadcast from consuming the shared Twilio/FCM quota every other tenant also depends on. This needs a global provider-side budget with weighted admission across tenants — neither design has this today, and it's the kind of thing that's easy to postpone until the first incident makes it urgent.

**Q3 — How does an erasure request reach the event backbone, not just the read model?**

Deleting a Cassandra/Postgres row is straightforward. A `recipientId` and payload sitting in a long-retention Kafka topic is a different problem — the log's durability is exactly what makes it hard to selectively forget. Worth deciding early whether payloads on the backbone should be by-reference (ids + template variables, content resolved at render time) specifically so retention policy has something narrow to act on.

**Q4 — Does every retry tier need its own consumer instance, or can one consumer own multiple tiers?**

The retry-ladder pattern (produce to `retry-30s`, wait, re-produce to the main topic) means a consumer sits idle for most of its wait window. At low volume that's fine; at real volume it's worth knowing whether one lightweight delay-aware consumer per channel scales, or whether tiers need to be split out — before the ladder is under enough load to make that answer expensive to get wrong.

**Q5 — Should the router support channel fallback ("SMS bounced, try push"), and if so, whose decision is that — the platform's or the tenant's?**

Centralizing channel choice in the router (item 03) makes fallback possible for the first time. Whether it should be a platform-wide policy, a per-tenant configuration, or a per-notification-type rule in `Preference` is a product decision, not an architecture one — flagged here so it isn't decided by default once the router exists.

**Q6 — What's the actual measured ceiling, once there's something to measure?**

Every throughput number in this report — including the corrected 12-60/sec estimate in §7 — is arithmetic against an illustrative growth curve, not a measurement. Once Phase 1's load-test step exists, replace every number in [`scaling-strategy.md`](http://scaling-strategy.md) (and the thresholds in §7 of this report) with what was actually observed.

---

*Adoption guide for notification-system (Design B) · reference: notification-system-design · 2026-08-26*