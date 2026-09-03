#!/usr/bin/env node
// Round-trips a real command through a live services/worker-inapp
// process — the thing WorkerService's/FeedWritingInAppGateway's
// fakes-based unit tests can't prove (a real Kafka consumer group, real
// Postgres dedupe claim + NotificationFeedItem write, real Redis
// pub/sub). Not part of the automated test suite (no live infra in CI
// yet — see roadmap.md's integration-tests item); run this by hand:
//
//   pnpm compose:up
//   pnpm kafka:topics
//   pnpm --filter @notification-system/worker-inapp build
//   pnpm --filter @notification-system/worker-inapp start &   (reads .env — see .env.example)
//   pnpm --filter @notification-system/worker-inapp smoke-test
//
// Seeds its own Tenant directly via Prisma, publishes one ChannelCommand
// straight onto command.in_app (bypassing services/router — this is a
// worker-level test), and asserts both the resulting delivery-status
// "sent" event and the Redis pub/sub feed notification arrive. Exits
// non-zero on any assertion failure or timeout.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@notification-system/infra-postgres";
import {
  createKafka,
  createKafkaProducer,
  KafkaConsumer,
  KafkaMessageBroker,
} from "@notification-system/infra-kafka";
import { createRedis, InAppSubscriber } from "@notification-system/infra-redis";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://notification:notification@localhost:5432/notification";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
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
let subscriber;
let subscriberRedis;
let redis;

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
    clientId: "worker-inapp-smoke-test",
  });
  producer = await createKafkaProducer(kafka);
  const broker = new KafkaMessageBroker(producer);

  consumer = new KafkaConsumer(kafka, {
    groupId: `worker-inapp-smoke-test-${randomUUID()}`,
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

  redis = createRedis({ url: REDIS_URL });
  subscriberRedis = redis.duplicate();
  subscriber = new InAppSubscriber(subscriberRedis);
  let resolveFeedNotification;
  const feedNotificationReceived = new Promise((resolve) => {
    resolveFeedNotification = resolve;
  });
  await subscriber.start((notification) => {
    if (notification.notificationRequestId !== notificationRequestId) {
      return; // another run's leftover message on the shared channel
    }
    resolveFeedNotification(notification);
  });

  console.log("Publishing a ChannelCommand directly onto command.in_app...");
  await broker.publishCommand({
    notificationRequestId,
    tenantId,
    recipientId,
    channel: "in_app",
    priority: "standard",
    renderedPayload: { body: "smoke test" },
    attemptNumber: 1,
  });

  console.log(
    `Waiting up to ${TIMEOUT_MS}ms for services/worker-inapp to write the feed row and publish...`,
  );
  const [status, feedNotification] = await Promise.all([
    withTimeout(statusReceived, "a delivery-status event"),
    withTimeout(
      feedNotificationReceived,
      "an in-app pub/sub feed notification",
    ),
  ]);

  assert.equal(status.status, "sent");
  assert.equal(feedNotification.recipientId, recipientId);
  assert.equal(feedNotification.renderedPayload.body, "smoke test");

  const feedItem = await prisma.notificationFeedItem.findUnique({
    where: { notificationRequestId },
  });
  assert.ok(feedItem, "the NotificationFeedItem row must exist");
  assert.equal(feedItem.summary, "smoke test");

  console.log("\nAll services/worker-inapp smoke tests passed.");
}

main()
  .catch((error) => {
    console.error("\nSMOKE TEST FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Runs on every path, not just success — a failed assertion or a
    // withTimeout() rejection used to skip straight to catch() above,
    // leaving these open connections keeping the event loop (and this
    // process) alive forever instead of actually exiting non-zero as
    // this script's own header promises. Found by hitting it directly
    // (a different service's smoke test): a failing run just hung.
    if (consumer) await consumer.stop();
    if (subscriber) await subscriber.stop();
    if (producer) await producer.disconnect();
    if (subscriberRedis) await subscriberRedis.quit();
    if (redis) await redis.quit();
    await prisma.$disconnect();
  });
