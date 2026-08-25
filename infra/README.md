# infra

Local infrastructure definitions. Phase 0 adds a `docker-compose.yml` here
running:
- `postgres` (official image — identity, preferences, templates)
- `cassandra` (official image, single node — notification delivery read model)
- `redis` (official image)
- `kafka` (official image, KRaft mode)
- `api`, `worker-sms`, `worker-push`, `worker-email`, `worker-inapp`,
  `projection-notification` (built from this repo, once they exist)

This is the only infrastructure defined in code for now — the hosted
free-tier demo (future work, not phased — see
[ADR 0004](../docs/adr/0004-phased-channel-rollout.md)) is configured
directly on each provider's dashboard rather than via IaC, and a future
paid-cloud Terraform setup is optional and not yet committed to. See
[`../docs/architecture/infra-strategy.md`](../docs/architecture/infra-strategy.md)
for the full rationale and migration path.

**Delivered in:** Phase 0 (compose skeleton), filled in through Phase 1.
