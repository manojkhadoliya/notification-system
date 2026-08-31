#!/usr/bin/env node
// Round-trips a real command through a live services/worker-email
// process — the thing WorkerService's fakes-based unit tests can't
// prove (a real Kafka consumer group, real Postgres dedupe claim +
// DeliveryAttempt write). Not part of the automated test suite (no live
// infra in CI yet — see roadmap.md's integration-tests item); run this
// by hand:
//
//   pnpm compose:up
//   pnpm kafka:topics
//   pnpm --filter @notification-system/worker-email build
//   pnpm --filter @notification-system/worker-email start &   (reads .env — see .env.example)
//   pnpm --filter @notification-system/worker-email smoke-test
//
// Seeds its own Tenant directly via Prisma, publishes one ChannelCommand
// straight onto command.email (bypassing services/router — this is a
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
    clientId: "worker-email-smoke-test",
  });
  const producer = await createKafkaProducer(kafka);
  const broker = new KafkaMessageBroker(producer);

  const consumer = new KafkaConsumer(kafka, {
    groupId: `worker-email-smoke-test-${randomUUID()}`,
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

  console.log("Publishing a ChannelCommand directly onto command.email...");
  await broker.publishCommand({
    notificationRequestId,
    tenantId,
    recipientId,
    channel: "email",
    priority: "standard",
    renderedPayload: {
      to: "a@example.com",
      subject: "Smoke test",
      body: "smoke test",
    },
    attemptNumber: 1,
  });

  console.log(
    `Waiting up to ${TIMEOUT_MS}ms for services/worker-email to dispatch and publish delivery-status...`,
  );
  const status = await withTimeout(statusReceived, "a delivery-status event");

  assert.equal(status.status, "sent");
  assert.equal(status.attemptNumber, 1);

  console.log("\nAll services/worker-email smoke tests passed.");

  await consumer.stop();
  await producer.disconnect();
}

main()
  .catch((error) => {
    console.error("\nSMOKE TEST FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
