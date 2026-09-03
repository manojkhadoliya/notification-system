#!/usr/bin/env node
// Round-trips a real command through a live services/worker-sms process
// — the thing WorkerService's fakes-based unit tests can't prove (a real
// Kafka consumer group, real Postgres dedupe claim + DeliveryAttempt
// write). Not part of the automated test suite (no live infra in CI yet
// — see roadmap.md's integration-tests item); run this by hand:
//
//   pnpm compose:up
//   pnpm kafka:topics
//   pnpm --filter @notification-system/worker-sms build
//   pnpm --filter @notification-system/worker-sms start &   (reads .env — see .env.example; defaults to the mock gateway)
//   pnpm --filter @notification-system/worker-sms smoke-test
//
// Seeds its own Tenant directly via Prisma, publishes one ChannelCommand
// straight onto command.sms (bypassing services/router — this is a
// worker-level test), and asserts the resulting delivery-status "sent"
// event arrives. Exits non-zero on any assertion failure or timeout.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@notification-system/infra-postgres";
import {
  createKafka,
  createKafkaProducer,
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

  const recipientId = randomUUID();
  const notificationRequestId = randomUUID();

  const kafka = createKafka({
    brokers: KAFKA_BROKERS,
    clientId: "worker-sms-smoke-test",
  });
  producer = await createKafkaProducer(kafka);
  const broker = new KafkaMessageBroker(producer);

  consumer = new KafkaConsumer(kafka, {
    groupId: `worker-sms-smoke-test-${randomUUID()}`,
    topics: ["delivery-status"],
  });

  let resolveStatus;
  const statusReceived = new Promise((resolve) => {
    resolveStatus = resolve;
  });
  await consumer.start(async (message) => {
    if (message.key !== notificationRequestId) {
      return; // another run's leftover message on a shared topic
    }
    resolveStatus(JSON.parse(message.value));
  });

  console.log("Publishing a ChannelCommand directly onto command.sms...");
  await broker.publishCommand({
    notificationRequestId,
    tenantId,
    recipientId,
    channel: "sms",
    priority: "standard",
    renderedPayload: { to: "+15551234567", body: "smoke test" },
    attemptNumber: 1,
  });

  console.log(
    `Waiting up to ${TIMEOUT_MS}ms for services/worker-sms to dispatch and publish delivery-status...`,
  );
  const status = await withTimeout(statusReceived, "a delivery-status event");

  assert.equal(status.status, "sent");
  assert.equal(status.attemptNumber, 1);

  console.log("\nAll services/worker-sms smoke tests passed.");
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
