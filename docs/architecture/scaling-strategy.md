# Scaling Strategy — Growth Without Redesign

## The goal, stated precisely

Not "handle N notifications/sec" for some fixed N. The actual requirement:
**as the number of users on this platform grows — illustratively, from
~100 at launch to on the order of 1,000,000 over 3-4 years — every layer of
this system absorbs that growth by adding capacity (partitions, nodes,
replicas, connections), never by replacing a technology or restructuring a
write/read path.** A "redesign" here specifically means: the kind of change
that touches `domain-*` code or forces a data-model rewrite. An infra/config
change — more partitions, more consumer replicas, a bigger cluster, a
connection pool, a cache in front of a hot read — is exactly what this
architecture is supposed to absorb without that.

No hard peak-throughput number is committed to. The illustrative curve
below uses ~1,000 notifications/sec as a rough, industry-ballpark peak at
the 1M-user mark, purely to size headroom against — not as a requirement.

## Illustrative growth curve

| Stage | ~Users (recipients across all tenants) | ~Peak notifications/sec | What has to change |
|---|---|---|---|
| Launch | 100 | <10 | Nothing — this is the local dev/demo baseline |
| Early growth | 10,000 | ~50-100 | Add Kafka partitions + consumer replicas; still one small node per store |
| Established | 100,000 | ~300-500 | Scale out Cassandra/Redis node counts; add a Postgres read replica if the cache-in-front (below) isn't enough |
| Target horizon | 1,000,000 | ~1,000+ | Same components, more of each — no new technology, no new data model |

This table is illustrative, not a commitment — the point is that every row
uses the *same* architecture, just more capacity.

## Per-component scaling story

| Component | What actually scales it | Headroom at ~1,000/sec (industry reference) | What would force a real redesign |
|---|---|---|---|
| `services/api` (Fastify) | Horizontal replicas behind a load balancer, autoscaled on CPU/request-rate | Stateless — a single modern Fastify instance handles low-thousands of simple req/sec; this is a replica-count change, not a ceiling | Only if a route stopped being stateless (e.g. in-memory session state) — not the case here |
| Kafka (notification hot path) | Partition count + consumer-group size ([ADR 0008](../adr/0008-elastic-scale-data-plane.md)) | A single broker commonly sustains 100K+ msgs/sec; even a modest 3-broker cluster is 100x+ headroom over a 1,000/sec peak | Only if the log-based model itself stopped fitting the access pattern — not expected at this scale |
| Cassandra/ScyllaDB (notification read model) | Add nodes; linear scaling | Tens of thousands of writes/sec per node is a normal reference figure; `NotificationRequest`/`DeliveryAttempt` partition keys are UUIDs, so load is already evenly spread regardless of tenant size | Only if the access pattern grew a real join/aggregate requirement — not present in this domain |
| Redis (rate limiting, idempotency, cache — see below) | Cluster, sharded by key | Cluster throughput scales with node count for well-distributed keys | **Known edge case, not solved here:** a single extremely high-volume tenant's `(tenantId, channel)` rate-limit key is one key, so it lands on one shard. Mitigation identified (split into N sub-buckets, sum/approximate) but not built — flagged honestly rather than silently assumed away. |
| Postgres (identity, preferences, templates) | Connection pooling (PgBouncer) + a read-through cache in front of the hot reads + a read replica if ever needed | `Tenant`/`ApiKey`/`Template` row counts stay small (thousands to low millions) even at 1M end-recipients, because recipients live in `domain-preferences`'s own table, not the tenant table; see "Keeping Postgres off the hot path" below | Only if this context's *write* volume ever approached the notification-send hot path — it structurally can't, tenant/template writes are provisioning-time events, not per-notification |

## Keeping Postgres off the hot path

Every dispatch checks two things that live in Postgres-backed contexts:
API-key validity (`domain-identity`, once per HTTP request) and recipient
preferences (`domain-preferences`, once per dispatch). At a 1,000/sec
dispatch rate, read-only lookups at that rate against a single Postgres
primary would themselves become the redesign trigger this whole document is
trying to avoid.

The fix: `infra-postgres`'s adapters for `ApiKeyRepository` and
`PreferenceRepository` are **read-through cached in Redis** (short TTL,
invalidated on write) — implementation detail inside the existing adapter,
not a change to either port, so `domain-identity`/`domain-preferences`
never know caching exists (per [ADR 0005](../adr/0005-ddd-hexagonal-architecture.md)'s
boundary). This means dispatch-path read volume scales with Redis (already
built for this — see the table above), and Postgres only ever sees
provisioning-rate traffic (new tenants, key rotation, preference edits) —
which stays low regardless of how large the *notification* volume grows.
This is what lets `domain-identity`/`domain-preferences` stay on a single
Postgres instance (per [ADR 0003](../adr/0003-database-postgres.md)) all the
way through the growth curve above, with connection pooling and an optional
read replica as the only levers ever needed.

## Why the Kafka partition key is `recipientId`, not `tenantId`

Partitioning by `tenantId` (an earlier version of this design) has a real
failure mode at the 1M-user horizon: a single large tenant's throughput is
capped at whatever *one* partition can do, no matter how many partitions
the topic has — because all of that tenant's traffic hashes to the same
key. That's exactly the kind of ceiling this document exists to design
around; growth concentrated in a few large tenants is at least as likely as
growth spread evenly across many small ones.

Partitioning by `recipientId` instead fixes this: a tenant's traffic is
already spread across its own many recipients, so it's spread across
partitions automatically as that tenant grows, and the ordering guarantee
that actually matters — one recipient's notifications process in order —
is preserved (tenant-wide ordering across different recipients was never a
real requirement). See [`messaging.md`](messaging.md) for the topic layout.

## What's an explicit, known trade-off — not solved here

- **Redis hot-key risk** for a single extreme-volume tenant's rate-limit
  counter (see table above). A real system approaching that edge would
  shard the counter; not built now because no current tenant profile
  demands it, and building it speculatively would be exactly the kind of
  gold-plating this project's own review process (see the
  business-logic/infra boundary test in
  [`domain-model.md`](domain-model.md)) argues against.
- **Real external provider throughput ceilings** (Twilio, FCM) are far
  below any number in this document and are unrelated to this system's
  architecture — a partnerships/multi-account problem, not a software one
  (carried over from [ADR 0008](../adr/0008-elastic-scale-data-plane.md)).

## Relationship to other docs

This document is the "how does growth get absorbed" narrative across the
*whole* system; [ADR 0008](../adr/0008-elastic-scale-data-plane.md) is the
decision record for *why* Kafka+Cassandra specifically back the
notification-delivery hot path, and
[`infra-strategy.md`](infra-strategy.md) is the local-vs-hosted deployment
story. All three describe the same architecture from different angles.
