# infra

Local infrastructure definitions.

`docker-compose.yml` (Phase 0) runs the four infra containers:
- `postgres` (official image — identity, preferences, templates, and,
  for Phase 1, notification delivery's read model too; no `cassandra`
  service until a threshold is crossed — see
  [`scaling-strategy.md`](../docs/architecture/scaling-strategy.md#storage-phasing))
- `redis` (official image)
- `kafka` (official image, KRaft mode — single broker, no Zookeeper)
- `jaeger` (all-in-one image — trace backend for
  `packages/observability`'s OTLP exporter; UI at
  `http://localhost:16686`)

`services/*` app containers (`api`, `router`, `scheduler`,
`fanout-expander`, `worker-sms`, `worker-push`, `worker-email`,
`worker-inapp`, `inapp-gateway`, `projection-notification`) are added to
this file once each has a Dockerfile and a real entrypoint — Phase 1, not
before.

## Usage

```
pnpm compose:up      # start postgres, redis, kafka, jaeger
pnpm kafka:topics    # create every topic in the topology (idempotent —
                      # safe to re-run), once kafka is healthy
pnpm compose:down    # stop and remove containers (volumes persist)
```

Topic definitions live in [`kafka/create-topics.sh`](kafka/create-topics.sh)
— the single source of truth for partition counts and retention, kept next
to [`../docs/architecture/messaging.md`](../docs/architecture/messaging.md#topic-layout)
which explains *why* each topic exists. Partition counts (3) and retention
figures there are local-dev defaults, not measured — see
[`scaling-strategy.md`](../docs/architecture/scaling-strategy.md)'s "every
figure is illustrative" note.

This is the only infrastructure defined in code for now — the hosted
free-tier demo (future work, not phased — see
[ADR 0004](../docs/adr/0004-channel-rollout.md)) is configured
directly on each provider's dashboard rather than via IaC, and a future
paid-cloud Terraform setup is optional and not yet committed to. See
[`../docs/architecture/infra-strategy.md`](../docs/architecture/infra-strategy.md)
for the full rationale and migration path.

**Delivered in:** Phase 0 (compose skeleton + topic creation), filled in
through Phase 1.
