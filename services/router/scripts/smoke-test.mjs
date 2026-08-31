#!/usr/bin/env node
// Round-trips a real event through a live services/router process — the
// thing RouterService's fakes-based unit tests can't prove (a real Kafka
// consumer group, real Postgres reads, real command/delivery-status
// publishes). Not part of the automated test suite (no live infra in CI
// yet — see roadmap.md's integration-tests item); run this by hand:
//
//   pnpm compose:up
//   pnpm kafka:topics
//   pnpm --filter @notification-system/router build
//   pnpm --filter @notification-system/router start &   (reads .env — see .env.example)
//   pnpm --filter @notification-system/router smoke-test
//
// Seeds its own Recipient directly via Prisma (no recipient-creation
// endpoint exists — see services/api/README.md), publishes one
// NotificationEvent onto events.standard, and asserts the corresponding
// command.sms + delivery-status messages arrive. Exits non-zero on any
// assertion failure or timeout.

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

async function seedRecipient() {
  const tenantId = randomUUID();
  const recipientId = randomUUID();
  await prisma.tenant.create({
    data: { id: tenantId, name: "smoke-test-tenant" },
  });
  await prisma.recipient.create({
    data: { id: recipientId, tenantId, phone: "+15551234567" },
  });
  return { tenantId, recipientId };
}

async function main() {
  const { tenantId, recipientId } = await seedRecipient();
  const notificationRequestId = randomUUID();

  const kafka = createKafka({
    brokers: KAFKA_BROKERS,
    clientId: "router-smoke-test",
  });
  const producer = await createKafkaProducer(kafka);
  const broker = new KafkaMessageBroker(producer);

  const consumer = new KafkaConsumer(kafka, {
    groupId: `router-smoke-test-${randomUUID()}`,
    topics: ["command.sms", "delivery-status"],
  });

  const received = new Map();
  let resolveAll;
  const allReceived = new Promise((resolve) => {
    resolveAll = resolve;
  });
  await consumer.start(async (message) => {
    if (message.key !== recipientId && message.key !== notificationRequestId) {
      return; // another run's leftover message on a shared topic
    }
    received.set(message.topic, message);
    if (received.has("command.sms") && received.has("delivery-status")) {
      resolveAll();
    }
  });

  console.log("Publishing a NotificationEvent onto events.standard...");
  await broker.publishEvent({
    notificationRequestId,
    tenantId,
    recipientId,
    notificationType: "order.shipped",
    channel: "sms",
    templateVersionId: null,
    payloadRef: { message: "your order shipped" },
    priority: "standard",
    broadcastId: null,
  });

  console.log(
    `Waiting up to ${TIMEOUT_MS}ms for services/router to pick it up and publish command.sms + delivery-status...`,
  );
  await withTimeout(allReceived, "command.sms and delivery-status");

  const command = JSON.parse(received.get("command.sms").value);
  assert.equal(command.renderedPayload.to, "+15551234567");
  assert.equal(command.renderedPayload.body, "your order shipped");

  const status = JSON.parse(received.get("delivery-status").value);
  assert.equal(status.status, "accepted");
  assert.equal(status.notificationRequestId, notificationRequestId);

  console.log("\nAll services/router smoke tests passed.");

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
