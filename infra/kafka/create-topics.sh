#!/usr/bin/env bash
# Creates every topic in the topology (see docs/architecture/messaging.md
# #topic-layout) against the local Kafka container. Idempotent — safe to
# re-run; existing topics are left alone (`--if-not-exists`).
#
# Usage: pnpm kafka:topics   (after `pnpm compose:up` and Kafka is healthy)
set -euo pipefail

COMPOSE_FILE="$(dirname "$0")/../docker-compose.yml"
SERVICE="kafka"
BROKER="localhost:9092"
KAFKA_TOPICS="/opt/kafka/bin/kafka-topics.sh"

# name:partitions:retention_ms
#
# Partition count (3) and retention are local-dev defaults, not measured —
# see scaling-strategy.md's "every figure is illustrative" note. Event
# topics get long retention (payload-by-reference, replay-worthy); command
# topics get short retention (self-contained, ephemeral once dispatched);
# DLQ topics get long retention (need to survive until someone looks at
# them).
TOPICS=(
  "events.critical:3:604800000"
  "events.standard:3:604800000"
  "events.bulk:3:604800000"
  "events.broadcast:3:604800000"
  "events.broadcast.chunks:3:604800000"
  "command.sms:3:3600000"
  "command.sms.retry-30s:3:3600000"
  "command.sms.retry-5m:3:3600000"
  "command.sms.retry-30m:3:3600000"
  "command.sms.dlq:3:604800000"
  "command.push:3:3600000"
  "command.push.retry-30s:3:3600000"
  "command.push.retry-5m:3:3600000"
  "command.push.retry-30m:3:3600000"
  "command.push.dlq:3:604800000"
  "command.email:3:3600000"
  "command.email.retry-30s:3:3600000"
  "command.email.retry-5m:3:3600000"
  "command.email.retry-30m:3:3600000"
  "command.email.dlq:3:604800000"
  "command.in_app:3:3600000"
  "command.in_app.retry-30s:3:3600000"
  "command.in_app.retry-5m:3:3600000"
  "command.in_app.retry-30m:3:3600000"
  "command.in_app.dlq:3:604800000"
  "delivery-status:3:86400000"
)

for entry in "${TOPICS[@]}"; do
  IFS=':' read -r name partitions retention_ms <<<"$entry"
  echo "Creating topic: $name (partitions=$partitions, retention.ms=$retention_ms)"
  docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" \
    "$KAFKA_TOPICS" --bootstrap-server "$BROKER" \
    --create --if-not-exists \
    --topic "$name" \
    --partitions "$partitions" \
    --replication-factor 1 \
    --config "retention.ms=$retention_ms"
done

echo "Done. Listing topics:"
docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" \
  "$KAFKA_TOPICS" --bootstrap-server "$BROKER" --list
