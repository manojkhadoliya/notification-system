#!/usr/bin/env node
// Round-trips a real broadcast through a live services/fanout-expander
// process — the thing FanoutExpanderService's fakes-based unit tests
// can't prove (a real Postgres audience resolution, real Kafka
// stage-1/stage-2 publishes). Not part of the automated test suite (no
// live infra in CI yet — see roadmap.md's integration-tests item); run
// this by hand:
//
//   pnpm compose:up
//   pnpm kafka:topics
//   pnpm --filter @notification-system/fanout-expander build
//   pnpm --filter @notification-system/fanout-expander start &   (reads .env — see .env.example)
//   pnpm --filter @notification-system/fanout-expander smoke-test
//
// Seeds its own Tenant + 3 Recipients directly via Prisma, then publishes
// a BroadcastRequest directly onto events.broadcast via
// KafkaMessageBroker.publishBroadcast — this *is* "the producer library
// (Door 2)" in practice: a thin, direct MessageBroker call, no HTTP hop
// (see docs/roadmap.md's Phase 0 entry for why no separate package exists
// for it). Asserts 3 individual events.standard messages arrive, one per
// seeded recipient, each carrying the same broadcastId back-reference.
// Exits non-zero on any assertion failure or timeout.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@notification-system/infra-postgres";
import {
  createKafka,
  createKafkaProducer,
  eventTopic,
  KafkaConsumer,
  KafkaMessageBroker,
} from "@notification-system/infra-kafka";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://notification:notification@localhost:5432/notification";
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(
  ",",
);
const TIMEOUT_MS = 15_000;
const RECIPIENT_COUNT = 3;

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

// Closed in the shared `.finally()` below, not just on the success path —
// see that block's comment for why a failure/timeout used to leave a
// zombie process holding these open forever.
let consumer;
let producer;

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for: ${label}`)),
      TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const tenantId = randomUUID();
  await prisma.tenant.create({
    data: { id: tenantId, name: "smoke-test-tenant" },
  });

  const recipientIds = [];
  for (let i = 0; i < RECIPIENT_COUNT; i++) {
    const recipientId = randomUUID();
    recipientIds.push(recipientId);
    await prisma.recipient.create({
      data: { id: recipientId, tenantId, phone: "+15551234567" },
    });
  }

  const broadcastId = randomUUID();
  const kafka = createKafka({
    brokers: KAFKA_BROKERS,
    clientId: "fanout-expander-smoke-test",
  });
  producer = await createKafkaProducer(kafka);
  const broker = new KafkaMessageBroker(producer);

  consumer = new KafkaConsumer(kafka, {
    groupId: `fanout-expander-smoke-test-${randomUUID()}`,
    topics: [eventTopic("standard")],
  });
  const received = [];
  let resolveAll;
  const allReceived = new Promise((resolve) => {
    resolveAll = resolve;
  });
  await consumer.start(async (message) => {
    const event = JSON.parse(message.value);
    if (event.broadcastId !== broadcastId) {
      return; // another run's leftover message on a shared topic
    }
    received.push(event);
    if (received.length === RECIPIENT_COUNT) resolveAll();
  });

  console.log(
    "Publishing a BroadcastRequest directly onto events.broadcast (the producer-library pattern)...",
  );
  await broker.publishBroadcast({
    id: broadcastId,
    tenantId,
    audienceDescriptor: { kind: "all_recipients" },
    notificationType: "digest",
    payload: { message: "smoke test broadcast" },
    priority: "standard",
    createdAt: new Date(),
  });

  console.log(
    `Waiting up to ${TIMEOUT_MS}ms for services/fanout-expander to resolve, chunk, and expand it...`,
  );
  await withTimeout(
    allReceived,
    `${RECIPIENT_COUNT} events.standard messages, one per recipient`,
  );

  const receivedRecipientIds = received.map((e) => e.recipientId).sort();
  assert.deepEqual(receivedRecipientIds, [...recipientIds].sort());
  for (const event of received) {
    assert.equal(event.broadcastId, broadcastId);
    assert.equal(event.payloadRef.message, "smoke test broadcast");
    assert.equal(event.channel, null);
  }
  // Every recipient got its own notificationRequestId.
  assert.equal(
    new Set(received.map((e) => e.notificationRequestId)).size,
    RECIPIENT_COUNT,
  );

  console.log("\nAll services/fanout-expander smoke tests passed.");
}

main()
  .catch((error) => {
    console.error("\nSMOKE TEST FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Runs on every path, not just success — a failed assertion or a
    // withTimeout() rejection used to skip straight to catch() above,
    // leaving the consumer/producer's open Kafka connections keeping
    // the event loop (and this process) alive forever instead of
    // actually exiting non-zero as this script's own header promises.
    // Found by hitting it directly (a different service's smoke test):
    // a failing run just hung.
    if (consumer) await consumer.stop();
    if (producer) await producer.disconnect();
    await prisma.$disconnect();
  });
