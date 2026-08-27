# Two Notification Designs — Architecture Review

**Design A:** `notification-system-design`

**Design B:** `notification-system`

**Reviewed:** HLD, ADRs, data model, messaging, scaling, compose/schema artifacts

**Date:** 2026-08-26

Both folders describe a four-channel notification system on Kafka. They are not two versions of the same architecture — they are two different products. This is a side-by-side read of the high-level designs, where each one breaks under growth, and the single design to build from the two.

---

## 1. The verdict, first

Neither design is the one to build as written. A is the better *pipeline* and the weaker *product*. B is the better *product skeleton* and has the more serious *correctness* problems.

**Design A — what it is: an internal event platform.**

Services emit facts; the system owns every downstream decision — channel routing, quiet hours, digests, broadcast fan-out, replay. Correct delivery semantics, no tenancy, no product surface.

**Design B — what it is: a multi-tenant send API.**

Tenants call `POST /v1/notifications` with a recipient and a channel. Strong tenancy, auth, templates and rate limits — but the caller keeps every hard decision, and the read path races the write path.

**Recommendation — build B's shell around A's core.**

Take B's tenancy, API contract, templates and hexagonal package structure. Take A's router-first pipeline, worker-side dedupe, scheduler and fan-out. Drop Cassandra until a measured threshold, and cut the partition budget by ~10×.

&gt; **The one-line difference that drives everything else:** in A, the system decides what to send. In B, the caller decides and the system delivers. Every capability gap and every race condition below traces back to that choice.

---

## 2. Where the two shapes diverge

Both use Kafka, both key by user/recipient id, both build a retry-tier topic ladder with a per-channel DLQ, both run local Docker Compose, both reject RabbitMQ for the same reason (a queue's throughput doesn't scale by adding consumers the way a partitioned log does). Below that shared floor they part company completely.

| Dimension | Design A | Design B |

|---|---|---|

| What the caller sends | A domain fact — `assignment.graded`, `payment.failed`. No channel named. | A send command — recipient + *one explicit channel* + payload. |

| Who picks the channel | The router, from stored preferences. | The client, per request. Multi-channel = multiple API calls. |

| Where preferences are checked | Router, *before* anything is written to a channel topic. | Worker, *after* the message is committed to a channel topic and projected. |

| Quiet hours | Deferral — writes `scheduled_notifications(due_at)`, re-emitted later. | Modeled in the domain; **no mechanism exists to honor it**. See B-4. |

| One event → many users | Chunked fan-out expander, ~1,000 recipients per chunk event. | Not present. The caller loops. |

| Command payload | Rendered and self-contained in the Kafka message. | Thin id-only envelope; worker reads the body back from Cassandra. See B-1. |

| Dedupe before provider call | Conditional claim on `(eventId, userId, channel)` in the worker. | None. Ingest-time idempotency key only, 24h TTL. |

| Tenancy | Absent. `userId` is the only identity. | First-class: tenant, hashed API keys, per-tenant rate policy, pooled infra. |

| Templates | "Render per channel." No template entity or versioning anywhere. | Immutable `TemplateVersion`; a sent request keeps rendering identically. |

| Audit &amp; analytics | Independent consumer groups off the log, off the delivery path. | Only the status projection. No separate audit stream. |

| Persistence | Postgres everywhere; documented swap to a partitioned KV for dedupe at scale. | Polyglot from day one: Postgres + Cassandra + Redis + Kafka. |

| Package structure | Services + one shared package. Structure is a convention. | DDD bounded contexts, ports/adapters, boundary enforced by dependency-cruiser. |

---

## 3. Good fit, wrong fit

"Which is better" is unanswerable until you fix the product. Each design is close to correct for one target and structurally wrong for the other.

| If the product is… | Design A | Design B | Why |

|---|---|---|---|

| An internal notification platform *(many first-party services, one org)* | **Good fit** | **Wrong fit** | B pushes channel choice, preference fallback, scheduling and fan-out back onto every calling team. The hard parts never get centralized — which is the whole reason to build the platform. |

| A notification API product *(external tenants, API keys, billing)* | **Wrong fit** | **Good fit** | A has no tenant entity, no auth surface, no per-tenant quota, no template management and no client-facing API contract. A single noisy producer can consume all partition and provider capacity. |

| A portfolio piece *(both docs state this goal)* | Strong, over-scoped | Strong, over-stored | A designs for 10K–100K/sec and 256 partitions to demo &lt;100/sec. B runs four datastores for load a single Postgres absorbs. Both are defensible if the gap is documented — A documents it explicitly, B's capacity numbers quietly justify the excess. |

Read together, the two folders are complementary rather than competing: A got the **delivery semantics** right and skipped the product; B got the **product boundary** right and rushed the delivery semantics.

---

## 4. Where Design A goes wrong

Ten findings. A's delivery model holds up; its weaknesses are unmodelled capacity, missing product surface, and artifacts that have drifted from the design.

### A-1 · High — Postgres carries three write streams that scale 1:1 with delivery

`audit_log`, `delivery_status`, `inapp_notifications` and `notification_dedupe` all take an insert per event, per attempt, or per channel — on one Postgres instance. §8's scaling path only ever promises to swap *preferences* and *dedupe*. The two genuinely unbounded append-only tables are never re-homed.

At a 7,000/sec peak across ~3 channels that is 21K+ delivery-status inserts/sec plus 7K audit inserts/sec against indexed tables. A single Postgres primary tops out roughly an order of magnitude below that.

**Fix** — put `delivery_status`, `audit_log` and the in-app feed behind a repository port and move them to a wide-column store at a stated threshold. This is exactly the table set Design B's Cassandra is right for.

### A-2 · High — No tenancy model at all

`userId` is the only identity in the design and the schema. There is no tenant entity, no API credential, no per-tenant quota, and no fairness mechanism. §13 lists "provider-side rate limiting and fairness across tenants" as an *open question* — but tenancy isn't a feature you add later; it is a column on every table and a term in every partition key decision.

**Fix** — adopt B's Identity &amp; Tenancy context wholesale before writing the schema.

### A-3 · High — Broadcast chunks violate the design's own partition-key rule

D3 states the partition key is `userId` on *every* topic. A fan-out chunk carries ~1,000 recipients and cannot be keyed by any one of them. The rule and the mechanism contradict each other, and the doc never names the exception.

Worse, the router treats a chunk "exactly like a single-user event" — so one record is 1,000 preference lookups and up to 4,000 command publishes, executed serially, holding a partition. That is a smaller version of the inline-expansion problem §7.4 exists to prevent.

**Fix** — key chunk events by `chunkId` as a documented exception, cap chunk size by *work* not recipient count (e.g. 200), and let the expander emit per-recipient events rather than having the router expand chunks.

### A-4 · Medium — The digest scheduler is a thundering herd waiting to happen

Daily digests default to `digest_hour = 9`. At a million users, a single local-time bucket makes hundreds of thousands of rows due inside one minute, emitted by one poller over one `due_at` index. "Sharded by time bucket at scale" is named in §5.7 but never designed, and the demo poller is stated to be correct only "below roughly thousands of scheduled rows."

**Fix** — shard the poller by `(due_minute, bucket)` with jittered `due_at` at write time, and claim rows with `SELECT … FOR UPDATE SKIP LOCKED` so pollers scale horizontally.

### A-5 · Medium — The partition budget is understated by roughly 10×

D4 fixes 256 partitions in production and prices a partition at "a directory and some file handles." Multiply it out: 3 priority topics + (4 channels × 3 retry tiers) + 4 command topics + 4 DLQ + status ≈ 30 topics. At 256 each that is ~7,700 partitions on a small cluster.

A partition is also a producer buffer (smaller batches → worse compression and *lower* throughput at low volume), a controller metadata entry, a replication stream, and a unit of rebalance time. The reasoning behind D4 is sound; the number isn't derived from anything.

**Fix** — size per topic against the actual ceiling: 64 on the priority event topics, 32 on commands, 6 on retry/DLQ. That is still 5–10× headroom over the honest peak.

### A-6 · Medium — No template model — which quietly breaks the replay guarantee

The router "renders the message per channel," but no template entity, version or table exists in the HLD or `init.sql`. A's headline property is that replay re-processes history safely. Replay a six-month-old event after the copy changed and it renders differently — the dedupe store suppresses the send, so the divergence stays invisible until the one case where it doesn't.

**Fix** — B's immutable `TemplateVersion`, referenced by id on the event. Solved problem; take the solution.

### A-7 · Medium — Full payloads in a long-retention log is a compliance stop

[`notification.events`](http://notification.events) retains complete payloads for the replay window, and the audit sink copies them into `audit_log` permanently. An immutable log cannot honor an erasure request. §13 flags this as future work — but it is the item most likely to block the design outright rather than merely cost more.

**Fix** — payload-by-reference in the long-retention topic (ids + template version + variable keys), rendered content only in short-retention command topics and a TTL'd store. B's thin envelope already has this property, for unrelated reasons.

### A-8 · Consistency — The provided artifacts contradict the design

`docker-compose.yml` still provisions a full RabbitMQ service with a management UI, commented "the delivery broker. Commands, retries, DLQ" — directly against guardrail D1. `kafka-init` creates exactly three topics [`notification.events`](http://notification.events), [`notification.delivery](http://notification.delivery)-status`, a single shared `notification.dlq`): no command topics, no retry ladder, no priority topics, no per-channel DLQ. The brief nonetheless lists topic creation as "already in `docker-compose.yml`'s `kafka-init`" and treats P0 as satisfied by it.

**Fix** — regenerate both artifacts from the HLD before P0, and delete the RabbitMQ service.

### A-9 · Consistency — The brief bans a word the HLD uses throughout

Brief §5 makes "Dispatcher" a banned term and mandates "Router." The HLD calls the component Dispatcher in §4, §5.4, §6.4 and every data-flow in §7. The two binding documents disagree on the name of the system's central component.

### A-10 · Process — Twelve decisions marked "reopen: never"

D5 and D6 earn it — they're correctness invariants. D9 (priority as separate topics) and D12 (no cell model) are engineering judgments contingent on load and broker choice. Marking a contingent judgment permanent is how a design stops absorbing evidence. Note also that D4's premise as phrased overstates: partitions *can* be added; what cannot survive is key→partition stability for existing keys — which the HLD itself states correctly.

---

## 5. Where Design B goes wrong

Ten findings. B's structure and product boundary are the best material in either folder. Its delivery path has two races and a missing dedupe, and one of the races is self-amplifying.

### B-1 · Critical — The worker races the projection for its own payload — and the race feeds itself

The Kafka envelope is "kept intentionally thin"; the worker "loads the full request payload from the `NotificationRepository` (Cassandra)." That row is written by `services/projection-notification`, a *separate consumer group on the same topic*. Nothing orders the two, and `ADR 0008` concedes the projection lags — the API spec even documents that a `GET` right after `202` may 404.

So the normal case is a worker consuming a message whose body has not been written yet. It has no way to distinguish "not projected yet" from "not found," so it fails the attempt and pushes into the retry ladder.

The failure mode is not a fixed error rate — it is a loop. Load rises → projection lag grows → more workers miss → more retry-topic produces and more Cassandra reads → the projection lags further. The system degrades fastest exactly when it is busiest.

**Fix** — put the rendered, self-contained payload in the command message, as Design A does. The "avoid a second source of truth" rationale doesn't apply: a command is an instruction, not a duplicate record.

### B-2 · High — Status can move backwards

Same race, opposite direction. The projection writes `status: accepted`; the worker independently persists `sent` and later `delivered`. A lagging projection writes `accepted` with a *later* wall-clock cell timestamp than the worker's `delivered`, and Cassandra resolves last-write-wins per cell. The row regresses.

Nothing in the data model prevents it — `status` is a plain enum column with no version, no state-machine guard, and no conditional update. "Projection consumers upsert idempotently" is true and insufficient: idempotent is not the same as monotonic.

**Fix** — one writer per row. Let a single status sink consume both the accept stream and `delivery-status` and apply an ordered state machine, or guard with a lightweight LWT on status rank.

### B-3 · High — No dedupe before the provider call

Idempotency in B is entirely at ingest: a client-supplied `Idempotency-Key` in Redis with a ~24h TTL, plus Kafka's idempotent producer. Neither protects the send. A worker that calls Twilio and dies before committing its offset re-delivers on rebalance and sends the SMS twice — the exact scenario Kafka's at-least-once default guarantees will happen.

[`messaging.md`](http://messaging.md) asserts "redelivery of an already-succeeded message is a safe no-op." That holds for the `DeliveryAttempt` *row* (same key, upsert). It does not hold for the side effect, which is the part that costs money and annoys recipients. The planned DLQ-replay admin endpoint inherits the same gap: replay means re-send.

**Fix** — A's D5/D6 verbatim: a conditional claim on `(requestId, recipientId, channel)` in the worker, immediately before the gateway call.

### B-4 · High — Preferences and quiet hours are checked too late to act on

The client names the channel; the preference check runs in the worker. An opted-out recipient's message is authenticated, rate-limited, produced, partitioned, projected into Cassandra, and consumed — and only then dropped. Every layer does work for a message that was never sendable.

Quiet hours is worse: `domain-preferences` models `QuietHours`, but B has no scheduler, no `due_at`, no digest, and no deferral path anywhere. There is nothing to defer *to*. In practice quiet hours becomes a silent drop, or a retry loop that exhausts the ladder into the DLQ — neither of which is "suppressed."

There is also no channel fallback: "SMS failed, try push" is impossible when the caller pinned one channel per request.

**Fix** — insert A's router between ingest and the channel topics, and add the `scheduled_notifications` table. This is the single largest structural change B needs.

### B-5 · High — No fan-out — a broadcast is a million API calls

The API accepts one recipient per request. A tenant announcing to 1M recipients issues 1M authenticated POSTs, 1M distinct idempotency keys, 1M Redis writes and 1M produces, all from an external client over the internet. The ingest tier and the idempotency store become the bottleneck for the most common high-volume notification pattern there is.

**Fix** — accept an audience descriptor and expand server-side in chunks (A's §7.4), with the chunk-key correction from A-3.

### B-6 · Medium — Cassandra is justified by a capacity estimate that doesn't hold

The HLD projects 1M users producing "~50–80M notifications/day." That is 26–80 notifications per user per day. Realistic consumer platforms land at 1–5. The honest figure is ~1–5M/day — roughly **12–60/sec average**, not the ~600–900/sec that number implies. The table is also internally inconsistent: "a few hundred/sec average" yields ~26M/day, not 50–80M.

At the honest number a single Postgres instance handles the write-heavy table without effort. And `ADR 0003` rejects distributed SQL because the access pattern is "write once, read by id, no joins" — which is equally an argument for an ordinary Postgres table with a partial index.

Cassandra isn't wrong as an *eventual* destination — it is the right home for `DeliveryAttempt`, the feed and audit at real volume. Adopting it on day one buys the eventual-consistency bug class in B-1 and B-2 for load that isn't there yet.

**Fix** — Postgres behind the same `NotificationRepository` port; swap to Cassandra/Scylla at a written threshold. B's own hexagonal boundary is what makes this a config change, so use it.

### B-7 · Medium — `worker-inapp` welds two unrelated scaling axes together

One process both consumes a partitioned Kafka topic and holds the WebSocket connection registry. Those don't align: a recipient's socket lands on whichever node the load balancer chose, while their messages land on whichever node owns their partition — usually a different one. The doc says the worker "holds the registry" without saying how the consuming node reaches a socket it doesn't hold.

The operational consequence is worse than the routing one: adding replicas to absorb a connection surge triggers a consumer-group rebalance and interrupts in-flight dispatch. Connection count and dispatch throughput now scale as one number.

**Fix** — A's split: a stateless `inapp-gateway` owning sockets, reached over Redis pub/sub, and a separate worker that writes the feed row. Scale each independently.

### B-8 · Medium — No audit trail independent of the delivery path

Delivery history exists only as the Cassandra projection, slated for a ~90-day TTL. There is no append-only audit stream, no analytics consumer group with its own offsets, and no replay-with-suppression story. "Kafka's log retention makes replay a native capability" is true of the log, but retention on the notify topics isn't sized, and replay without B-3's claim means re-sending.

**Fix** — A's §5.8: separate audit and analytics consumer groups off the backbone, never on the delivery path.

### B-9 · Low — Two Redis pressure points, one acknowledged

The `(tenantId, channel)` rate-limit hot key is flagged honestly, with the sharded-sub-bucket mitigation identified and deliberately unbuilt — that judgment is fine. The unflagged one is the read-through preference/API-key cache: after a deploy or a Redis restart the cache is cold and full dispatch-rate read volume hits the single Postgres primary at once. No request coalescing or TTL jitter is mentioned, and "keeping Postgres off the hot path" is the load-bearing claim for staying single-instance.

### B-10 · Process — All eight ADRs sit at "In Progress"

Nothing is marked Accepted, including decisions later ADRs build on directly. ADR status is how a reader tells a settled decision from an open one; with every record in the same state, it carries no signal.

---

## 6. Will it burst as users grow?

Working assumption for both: 1M recipients, 3 notifications per user per day ≈ 35/sec average. Applying A's own documented 200× peak-to-average ratio gives a ~7,000/sec peak. Both designs survive that on paper. The question is what fails first, and whether it fails gracefully.

| # | Design | First thing to break | Mode | Recoverable? |

|---|---|---|---|---|

| 1 | B | Projection lag → worker payload misses (B-1) | Self-amplifying | No — the retry storm it triggers is additional load on the same two components that are already behind. Needs a code change, not capacity. |

| 2 | B | Broadcast via 1M client API calls (B-5) | Hard ceiling | No — a missing capability. Adding API replicas moves the bottleneck to the idempotency store. |

| 3 | A | Postgres delivery-status + audit inserts (A-1) | Saturation | Partly — sinks are off the delivery path, so notifications keep going out while audit lags. Fixed by re-homing two tables. |

| 4 | A | Digest thundering herd at the hour boundary (A-4) | Periodic spike | Yes — jitter and poller sharding are config-scale fixes, and the backlog drains. |

| 5 | B | WebSocket scaling forces consumer rebalance (B-7) | Coupling | Yes, but every scale-up event costs in-flight dispatch until the services are split. |

| 6 | A | Provider quota exhaustion under broadcast | External | Unmitigated — A lists cross-tenant provider fairness as an open question and has no tenant to be fair between. B has the rate limiter A needs. |

| 7 | A | ~7,700 partitions on a small cluster (A-5) | Overhead | Yes — degrades rebalance time and batch efficiency rather than failing. Self-inflicted, cheap to right-size before launch. |

| 8 | B | Cold preference cache after deploy (B-9) | Transient | Yes — seconds of elevated Postgres load, fixed with coalescing and TTL jitter. |

| 9 | B | Cassandra capacity | No pressure | Massively over-provisioned for the real curve — see B-6. |

### The honest summary

**Design A scales and degrades correctly.** Its failure modes are saturation and backlog — things that get slower and then catch up. Nothing in A's delivery path amplifies its own load, and the sinks are deliberately off the critical path so audit lag never stops a send. Its real ceiling is a Postgres instance doing work that belongs elsewhere, and that is a swap it already has the ports-shaped seam for, if not yet the ports.

**Design B has one failure mode that does not self-correct.** B-1 is a positive feedback loop sitting on the main delivery path, and it is invisible at demo volume — a single-broker Compose stack with no lag will never surface it. That is the worst kind of scaling bug: correct in every environment you can cheaply test, and worse the more successful the system gets.

So: yes, B bursts. Not because it lacks capacity, but because the read-your-own-write dependency between two parallel consumer groups tightens exactly when capacity gets tight. Removing the dependency — putting the payload in the message — costs one field in an envelope and eliminates the whole class.

---

## 7. The design to build

One pipeline, taken from A. One product boundary and package structure, taken from B. Right-sized infrastructure that starts on Postgres and grows into Cassandra behind a port that already exists.

Two ingress paths land on the same backbone, so the system serves both products: internal services publish facts, external tenants call the API. Everything downstream of the event topics is identical for both.

```

 INGRESS ─ two doors, one backbone

   POST /v1/notifications ──┐   tenant auth · Idempotency-Key · ingest rate limit

   (recipient | audience,   │   accepts an INTENT, not a channel command

    type, vars, template)   │

                            ├──▶  events.critical / events.standard / events.bulk

   [notification.events](http://notification.events) ─────┘     key: recipientId   (chunk events: key chunkId)

   (internal domain facts)        payload BY REFERENCE · long retention

 ROUTER  ─ the single decision point  ────────────────────────────────────────

   tenant + preferences (Redis read-through ▸ Postgres)

   quiet hours / digest ──▶ scheduled_notifications(due_at) ──▶ back to events

   template render (immutable TemplateVersion)

   priority class · channel set · per-tenant fairness

        │

        └─▶ command.{email|sms|push|inapp}   key: recipientId

            SELF-CONTAINED rendered payload · short retention

              ▲

 FAN-OUT EXPANDER ─ audience descriptor ▸ work-sized chunks ▸ per-recipient events

 WORKERS ─ one consumer group per channel  ──────────────────────────────────

   1. rate-limit check (tenantId, channel)          ← from B

   2. dedupe CLAIM (requestId, recipientId, channel) ← from A · before the call

   3. provider call

   4. publish delivery-status

   on failure ▸ retry.{channel}.{30s|5m|30m} ▸ dlq.{channel}

 IN-APP ─ split, not welded

   worker-inapp ▸ writes feed row ▸ Redis pub/sub ▸ inapp-gateway (holds sockets)

 SINKS ─ independent consumer groups, never on the delivery path

   status projection (single writer, ordered state machine)

   audit (append-only)      analytics (own offsets)

```

### What comes from where

| Element | Source | Correction applied |

|---|---|---|

| Tenant, API key, per-tenant rate policy | B | None — take as written. |

| Client API contract, `Idempotency-Key`, `202` semantics | B | Request accepts an *intent* (type + optional channel override + optional audience), not a fixed single channel. |

| Immutable `TemplateVersion` | B | None — this is what makes A's replay claim true. |

| DDD contexts, ports/adapters, dependency-cruiser boundary | B | None. This is the mechanism that makes the storage phasing below a config change. |

| ADR discipline (context / alternatives / consequences) | B | Add real `Accepted` / `Superseded` statuses (B-10). |

| Fact-based internal ingress, priority topics | A | None. |

| Router as the single decision point | A | Now also resolves tenant and template version. Fixes B-4. |

| Self-contained rendered command payload | A | Explicitly replaces B's thin envelope. Fixes B-1. |

| Worker-side dedupe claim before the provider call | A | Key gains `tenantId`. Fixes B-3 and makes DLQ replay safe. |

| Scheduler, quiet-hours deferral, digests | A | Jittered `due_at` + sharded poller with `SKIP LOCKED`. Fixes A-4, B-4. |

| Chunked broadcast fan-out | A | Chunks keyed by `chunkId` (documented exception); expander emits per-recipient events. Fixes A-3, B-5. |

| Retry ladder + per-channel DLQ | Both | Tiers `30s / 5m / 30m`; per-channel DLQ, not one shared. |

| Independent audit + analytics consumer groups | A | None. Fixes B-8. |

| Status projection | Both | **Single writer** consuming both accept and `delivery-status`, applying an ordered state machine. Fixes B-2. |

| In-app gateway split from the feed worker | A | Redis pub/sub between them. Fixes B-7. |

| Cassandra / Scylla | B | **Deferred.** Adopted for `delivery_status`, `audit_log`, `notification_feed` and dedupe claims at a measured threshold — not on day one. Fixes A-1 and B-6 at once. |

| Payload-by-reference in the long-retention log | B | Adopted for A's backbone specifically as the PII answer. Fixes A-7. |

### What gets dropped, and why

- **B's thin id-only envelope.** Its stated rationale — avoid a second source of truth for request content — misreads the artifact. A command is an instruction with a lifetime of seconds, not a record. Keeping it thin costs a read-your-own-write dependency on the delivery path.

- **B's parallel projection-as-payload-writer.** The projection stays, as a read model; it stops being something the delivery path depends on.

- **A's 256-partition default.** Replaced by per-topic sizing derived from the honest peak.

- **A's "reopen: never" column.** Kept for the two correctness invariants (dedupe placement, dedupe key). Replaced with ADR status elsewhere.

- **The RabbitMQ service in A's compose file.** Both designs reject RabbitMQ for the same reason and reach the same retry-ladder conclusion. The container is leftover.

### Storage phasing — with thresholds, not vibes

Everything sits behind a repository port from day one, so each move is an adapter swap and a connection string.

| Data | Phase 1 | Move when | Moves to |

|---|---|---|---|

| Tenants, API keys, preferences, templates | Postgres | never | Stays — provisioning-rate writes, Redis-cached reads |

| `scheduled_notifications` | Postgres | never | Stays — needs range queries on `due_at`; a log can't answer them |

| Dedupe claims | Postgres unique constraint | &gt; ~2K claims/sec | Partitioned KV (Scylla / DynamoDB-style conditional write) |

| `delivery_status`, `audit_log` | Postgres append-only | &gt; ~5K inserts/sec sustained | Cassandra / Scylla — the write-heavy, id-keyed, join-free case |

| In-app feed | Postgres, partial index on unread | &gt; ~50M live rows | Cassandra, partitioned by `recipientId`, clustered `created_at desc` |

### Build order

A's phase structure, with B's contexts scaffolded first because tenancy is not retrofittable:

- **P0** — pnpm workspaces, four domain contexts, dependency-cruiser boundary rule, Compose (Kafka KRaft, Postgres, Redis, Mailpit, Jaeger — no RabbitMQ, no Cassandra), topic creation matching the actual topology.

- **P1** — Tenancy + auth + ingest API + router + one channel end to end. Ends at mail in Mailpit.

- **P2** — Four channels, templates, worker-side dedupe claim. Acceptance: same request id twice sends once.

- **P3** — Retry ladder, per-channel DLQ, delivery-status, single-writer status projection, audit + analytics sinks.

- **P4** — Scheduler, quiet-hours deferral, digests, fan-out expander. Acceptance: a 10K broadcast doesn't starve a concurrent single-recipient send.

- **P5** — OpenTelemetry through Kafka headers, offset-reset replay with `--dry-run`, Prometheus/Grafana on lag, depth, delivery rate, DLQ count. Acceptance: replay 10K events, zero duplicate provider calls.

- **P6** — Admin surface, DLQ inspector, k6 run that publishes the *measured* ceiling of each component.

&gt; **Keep A's discipline about the demo/production gap.** Its instruction that the gap "must be documented, never disguised," and its §11 substitution table, are the strongest documentation practice in either folder. B's capacity estimate (B-6) is what happens without it — a number inflated just enough to justify infrastructure the honest number wouldn't.

---

## 8. Scorecard

Fifteen parameters, scored against a system intended to survive user growth without redesign. Merged column shows the outcome after the corrections in §7.

| Parameter | A | B | Merged | Note |

|---|---|---|---|---|

| Delivery guarantee &amp; dedupe | Strong | Weak | Strong | A's claim placement is the correct answer; B has no pre-send claim at all. |

| Routing &amp; decision placement | Strong | Weak | Strong | Decide before the channel topic, not after. |

| Scheduling / quiet hours / digests | Strong | Absent | Strong | B models quiet hours with no mechanism to honor it. |

| Broadcast / fan-out | Partial | Absent | Strong | A has the mechanism; the chunk key needs fixing. |

| Multi-tenancy &amp; isolation | Absent | Strong | Strong | B's model is complete, including the hot-key caveat. |

| API / product surface | Absent | Strong | Strong | Auth, idempotency header, status endpoint, webhooks. |

| Templates &amp; content versioning | Absent | Strong | Strong | Immutable versions; also repairs A's replay claim. |

| Read/write consistency | Sound | Racy | Sound | Single-writer status projection replaces the race. |

| Audit &amp; analytics | Strong | Thin | Strong | Independent groups, off the delivery path. |

| Storage fit for load | Under | Over | Right-sized | A under-plans two tables; B over-buys a cluster. |

| Burst behaviour | Degrades | Amplifies | Degrades | Degrading is acceptable; amplifying is not. |

| Package structure &amp; boundaries | Convention | Enforced | Enforced | Lint-enforced boundaries are what make the phasing cheap. |

| Observability &amp; testing plan | Strong | Adequate | Strong | A specifies concurrency, ordering and starvation tests by name. |

| Security &amp; PII | Open | Solid | Solid | Hashed keys, signature verification, payload-by-reference, TTL. |

| Internal consistency of the docs | Drifted | Coherent | — | A's compose, topic list and terminology contradict its own HLD. |

---

## 9. Still open

Neither folder answers these, and the merged design doesn't either. They're listed so they stay visible rather than getting absorbed into "future work."

- **Cross-tenant provider fairness.** Per-tenant rate limits cap a tenant against *itself*. They don't stop one tenant's broadcast from consuming the shared Twilio or FCM quota that every other tenant depends on. This needs a global provider budget with weighted admission, and neither design has one.

- **Erasure against the event log.** Payload-by-reference moves the problem, it doesn't close it. Ids and template variables in a long-retention topic are still personal data in most readings.

- **Retry-tier consumer topology.** Both designs pause a consumer to wait out a delay. Whether each tier needs its own instance, and what happens when one tier's backlog outlives its delay window, is unanswered in both.

- **Channel fallback policy.** "SMS hard-bounced, try push" is a genuine notification-platform feature. A's router is the right place for it; neither design specifies it.

- **The measured ceiling.** Both claim scale properties no local Compose stack can demonstrate. Until the k6 run in P6 produces real numbers per component, every throughput figure in either folder — including the ones in this report — is arithmetic, not evidence.

---

*Review of two candidate high-level designs · Design A: notification-system-design · Design B: notification-system · 2026-08-26*