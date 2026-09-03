#!/usr/bin/env node
// Round-trips a real accepted -> sent -> delivered sequence through a
// live services/projection-notification process — the thing
// ProjectionService's fakes-based unit tests can't prove (a real Kafka
// consumer group, real Postgres upserts, real ordering across separate
// publishes). Not part of the automated test suite (no live infra in CI
// yet — see roadmap.md's integration-tests item); run this by hand:
//
//   pnpm compose:up
//   pnpm kafka:topics
//   pnpm --filter @notification-system/projection-notification build
//   pnpm --filter @notification-system/projection-notification start &   (reads .env — see .env.example)
//   pnpm --filter @notification-system/projection-notification smoke-test
//
// Publishes three delivery-status messages directly (bypassing
// services/router/the channel workers — this is a projection-level
// test), then polls Postgres until the row reaches "delivered" or times
// out. Exits non-zero on any assertion failure or timeout.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@notification-system/infra-postgres";
import {
  createKafka,
  createKafkaProducer,
  KafkaMessageBroker,
} from "@notification-system/infra-kafka";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://notification:notification@localhost:5432/notification";
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(
  ",",
);
const TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

// Closed in the shared `.finally()` below, not just on the success path —
// see that block's comment for why a failure/timeout used to leave a
// zombie process holding this open forever.
let producer;

async function pollUntil(fn, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
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
    clientId: "projection-notification-smoke-test",
  });
  producer = await createKafkaProducer(kafka);
  const broker = new KafkaMessageBroker(producer);

  console.log("Publishing accepted...");
  await broker.publishDeliveryStatus({
    notificationRequestId,
    status: "accepted",
    attemptNumber: 0,
    occurredAt: new Date(),
    tenantId,
    recipientId,
    notificationType: "order.shipped",
    idempotencyKey: "smoke-test-key",
    channel: "sms",
    broadcastId: null,
    payload: { to: "+15551234567", body: "smoke test" },
  });

  await pollUntil(async () => {
    const row = await prisma.notificationRequest.findUnique({
      where: { id: notificationRequestId },
    });
    return row?.status === "accepted" ? true : undefined;
  }, "the row to reach status accepted");
  console.log("...reached accepted.");

  console.log("Publishing sent...");
  await broker.publishDeliveryStatus({
    notificationRequestId,
    status: "sent",
    attemptNumber: 1,
    occurredAt: new Date(),
  });
  await pollUntil(async () => {
    const row = await prisma.notificationRequest.findUnique({
      where: { id: notificationRequestId },
    });
    return row?.status === "sent" ? true : undefined;
  }, "the row to reach status sent");
  console.log("...reached sent.");

  console.log("Publishing delivered...");
  await broker.publishDeliveryStatus({
    notificationRequestId,
    status: "delivered",
    attemptNumber: 1,
    occurredAt: new Date(),
  });
  const finalRow = await pollUntil(async () => {
    const row = await prisma.notificationRequest.findUnique({
      where: { id: notificationRequestId },
    });
    return row?.status === "delivered" ? row : undefined;
  }, "the row to reach status delivered");
  console.log("...reached delivered.");

  assert.equal(finalRow.tenantId, tenantId);
  assert.equal(finalRow.recipientId, recipientId);
  assert.equal(finalRow.channel, "sms");
  assert.equal(finalRow.idempotencyKey, "smoke-test-key");
  assert.deepEqual(finalRow.payload, {
    to: "+15551234567",
    body: "smoke test",
  });

  console.log("\nAll services/projection-notification smoke tests passed.");
}

main()
  .catch((error) => {
    console.error("\nSMOKE TEST FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Runs on every path, not just success — a failed assertion or a
    // pollUntil() timeout used to skip straight to catch() above,
    // leaving the producer's open Kafka connection keeping the event
    // loop (and this process) alive forever instead of actually
    // exiting non-zero as this script's own header promises. Found by
    // hitting it directly (a different service's smoke test): a
    // failing run just hung.
    if (producer) await producer.disconnect();
    await prisma.$disconnect();
  });
