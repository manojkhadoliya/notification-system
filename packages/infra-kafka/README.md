# packages/infra-kafka

Implements the `MessageBroker` port defined by `domain-notification`, using
a Kafka client against Kafka. Owns the topic/partition/retry-topic/DLQ
topology setup (see
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md)).
Used by `services/api` to produce accepted requests directly (no outbox —
Kafka's replication is the durability guarantee), and by
`services/worker-sms`/`services/worker-push`/`services/projection-notification`
to consume.

Depends on `domain-notification` (to implement its port interface); never
the reverse.

**Delivered in:** Phase 1. Renamed from `infra-rabbitmq`; rationale for
Kafka in [ADR 0008](../../docs/adr/0008-elastic-scale-data-plane.md)
(supersedes [ADR 0002](../../docs/adr/0002-queue-choice-rabbitmq.md)).
