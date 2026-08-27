# infra

Local infrastructure definitions. Phase 0 adds a `docker-compose.yml` here
running:
- `postgres` (official image — identity, preferences, templates, and,
  for Phase 1, notification delivery's read model too; no `cassandra`
  service until a threshold is crossed — see
  [`scaling-strategy.md`](../docs/architecture/scaling-strategy.md#storage-phasing))
- `redis` (official image)
- `kafka` (official image, KRaft mode)
- `api`, `router`, `scheduler`, `fanout-expander`, `worker-sms`,
  `worker-push`, `worker-email`, `worker-inapp`, `inapp-gateway`,
  `projection-notification` (built from this repo, once they exist)

This is the only infrastructure defined in code for now — the hosted
free-tier demo (future work, not phased — see
[ADR 0004](../docs/adr/0004-channel-rollout.md)) is configured
directly on each provider's dashboard rather than via IaC, and a future
paid-cloud Terraform setup is optional and not yet committed to. See
[`../docs/architecture/infra-strategy.md`](../docs/architecture/infra-strategy.md)
for the full rationale and migration path.

**Delivered in:** Phase 0 (compose skeleton), filled in through Phase 1.
