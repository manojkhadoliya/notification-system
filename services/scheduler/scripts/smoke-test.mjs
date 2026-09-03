#!/usr/bin/env node
// Round-trips a real due ScheduledNotification row through a live
// services/scheduler process — the thing SchedulerService's fakes-based
// unit tests can't prove (a real Postgres SELECT ... FOR UPDATE SKIP
// LOCKED claim, a real Kafka publish). Not part of the automated test
// suite (no live infra in CI yet — see roadmap.md's integration-tests
// item); run this by hand:
//
//   pnpm compose:up
//   pnpm kafka:topics
//   pnpm --filter @notification-system/scheduler build
//   pnpm --filter @notification-system/scheduler start &   (reads .env — see .env.example)
//   pnpm --filter @notification-system/scheduler smoke-test
//
// Seeds its own Tenant + a due ScheduledNotification row directly via
// Prisma (bypassing services/router — this is a scheduler-level test),
// and asserts both the resulting events.standard message arrives with
// the *original* notificationRequestId (not the row's own id — see
// ScheduledNotification.notificationRequestId's doc comment) and the row
// transitions to "emitted" in Postgres. Exits non-zero on any assertion
// failure or timeout.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@notification-system/infra-postgres";
import {
  createKafka,
  eventTopic,
  KafkaConsumer,
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
// zombie process holding this open forever.
let consumer;

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
  const rowId = randomUUID();

  console.log("Seeding a due ScheduledNotification row directly...");
  await prisma.scheduledNotification.create({
    data: {
      id: rowId,
      notificationRequestId,
      tenantId,
      recipientId,
      notificationType: "digest",
      payload: { message: "smoke test" },
      priority: "standard",
      dueAt: new Date(Date.now() - 1000), // already due
      dueMinute: Math.floor((Date.now() - 1000) / 60_000),
      status: "pending",
    },
  });
  assert.notEqual(rowId, notificationRequestId); // sanity: distinct ids

  const kafka = createKafka({
    brokers: KAFKA_BROKERS,
    clientId: "scheduler-smoke-test",
  });
  consumer = new KafkaConsumer(kafka, {
    groupId: `scheduler-smoke-test-${randomUUID()}`,
    topics: [eventTopic("standard")],
  });
  let resolveEvent;
  const eventReceived = new Promise((resolve) => {
    resolveEvent = resolve;
  });
  await consumer.start(async (message) => {
    if (message.key !== recipientId) {
      return; // another run's leftover message on a shared topic
    }
    resolveEvent(JSON.parse(message.value));
  });

  console.log(
    `Waiting up to ${TIMEOUT_MS}ms for services/scheduler to claim and re-emit it...`,
  );
  const event = await withTimeout(
    eventReceived,
    "an events.standard message re-emitted by services/scheduler",
  );

  assert.equal(event.notificationRequestId, notificationRequestId);
  assert.equal(event.recipientId, recipientId);
  assert.equal(event.payloadRef.message, "smoke test");

  const row = await prisma.scheduledNotification.findUnique({
    where: { id: rowId },
  });
  assert.ok(row, "the ScheduledNotification row must still exist");
  assert.equal(row.status, "emitted");

  console.log("\nAll services/scheduler smoke tests passed.");
}

main()
  .catch((error) => {
    console.error("\nSMOKE TEST FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Runs on every path, not just success — a failed assertion or a
    // withTimeout() rejection used to skip straight to catch() above,
    // leaving the consumer's open Kafka connection keeping the event
    // loop (and this process) alive forever instead of actually
    // exiting non-zero as this script's own header promises. Found by
    // hitting it directly: a failing run just hung.
    if (consumer) await consumer.stop();
    await prisma.$disconnect();
  });
