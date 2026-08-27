#!/usr/bin/env node
// Round-trips one message through KafkaMessageBroker (produce) and
// KafkaConsumer (consume) against a real, reachable Kafka broker — the
// thing a typecheck alone can't prove. Not part of the automated test
// suite (no live broker in CI yet — see roadmap.md's integration-tests
// item); run this by hand after the topics exist:
//
//   pnpm compose:up
//   pnpm kafka:topics
//   pnpm --filter @notification-system/infra-kafka build
//   pnpm --filter @notification-system/infra-kafka smoke-test
//
// Exits non-zero if the consumed message doesn't match what was produced,
// or if nothing arrives within the timeout.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createKafka,
  createKafkaProducer,
  KafkaConsumer,
  KafkaMessageBroker,
} from "../dist/index.js";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";

const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");
const TIMEOUT_MS = 15_000;

const kafka = createKafka({
  brokers: BROKERS,
  clientId: "infra-kafka-smoke-test",
});

async function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for: ${label}`)),
      TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const producer = await createKafkaProducer(kafka);
  const broker = new KafkaMessageBroker(producer);

  const notificationRequestId = NotificationRequestId(randomUUID());
  const tenantId = TenantId(randomUUID());
  const recipientId = RecipientId(randomUUID());

  const consumer = new KafkaConsumer(kafka, {
    groupId: `infra-kafka-smoke-test-${randomUUID()}`,
    topics: [
      "events.standard",
      "command.sms",
      "command.sms.retry-30s",
      "command.sms.dlq",
      "delivery-status",
    ],
  });

  const received = new Map();
  let resolveAll;
  const allReceived = new Promise((resolve) => {
    resolveAll = resolve;
  });
  const expectedTopics = new Set([
    "events.standard",
    "command.sms",
    "command.sms.retry-30s",
    "command.sms.dlq",
    "delivery-status",
  ]);

  await consumer.start(async (message) => {
    if (message.key !== recipientId && message.key !== notificationRequestId) {
      return; // another test/run's leftover message on a shared topic
    }
    received.set(message.topic, message);
    if ([...expectedTopics].every((t) => received.has(t))) {
      resolveAll();
    }
  });

  console.log("Producing one message to each topic this smoke test covers...");

  await broker.publishEvent({
    notificationRequestId,
    tenantId,
    recipientId,
    notificationType: "smoke-test",
    channel: null,
    templateVersionId: null,
    payloadRef: { foo: "bar" },
    priority: "standard",
    broadcastId: null,
  });

  const command = {
    notificationRequestId,
    tenantId,
    recipientId,
    channel: "sms",
    priority: "standard",
    renderedPayload: { body: "hello from the smoke test" },
    attemptNumber: 1,
  };
  await broker.publishCommand(command);
  await broker.scheduleRetry(command, 30_000);
  await broker.publishToDlq(command, "smoke-test-forced-failure");
  await broker.publishDeliveryStatus({
    notificationRequestId,
    status: "sent",
    attemptNumber: 1,
    occurredAt: new Date(),
  });

  console.log(`Waiting up to ${TIMEOUT_MS}ms to consume all five back...`);
  await withTimeout(allReceived, "all five produced messages to be consumed");

  assert.equal(
    JSON.parse(received.get("events.standard").value).notificationType,
    "smoke-test",
  );
  assert.equal(
    JSON.parse(received.get("command.sms").value).renderedPayload.body,
    "hello from the smoke test",
  );
  const retryMessage = received.get("command.sms.retry-30s");
  assert.ok(
    retryMessage.headers["x-retry-after"],
    "retry message must carry an x-retry-after header",
  );
  assert.equal(
    JSON.parse(received.get("command.sms.dlq").value).reason,
    "smoke-test-forced-failure",
  );
  assert.equal(
    JSON.parse(received.get("delivery-status").value).status,
    "sent",
  );

  console.log("\nAll five topics round-tripped correctly.");

  await consumer.stop();
  await producer.disconnect();
}

main().catch((error) => {
  console.error("\nSMOKE TEST FAILED:", error);
  process.exitCode = 1;
});
