# infra

Local infrastructure definitions. Phase 0 adds a `docker-compose.yml` here
running:
- `postgres` (official image)
- `redis` (official image)
- `rabbitmq` (official image, management plugin enabled)
- `api`, `worker-sms`, `worker-push` (built from this repo, once they
  exist)

This is the only infrastructure defined in code for now — the Phase 1.5
hosted free-tier demo is configured directly on each provider's dashboard
rather than via IaC, and a future paid-cloud Terraform setup (Phase 4) is
optional and not yet committed to. See
[`../docs/architecture/infra-strategy.md`](../docs/architecture/infra-strategy.md)
for the full rationale and migration path.

**Delivered in:** Phase 0 (compose skeleton), filled in through Phase 1.
