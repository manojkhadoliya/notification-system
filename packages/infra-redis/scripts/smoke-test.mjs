#!/usr/bin/env node
// Round-trips real behavior against a live, reachable Redis — the thing a
// typecheck alone can't prove. Not part of the automated test suite (no
// live Redis in CI yet — see roadmap.md's integration-tests item); run
// this by hand:
//
//   pnpm compose:up
//   pnpm --filter @notification-system/infra-redis build
//   pnpm --filter @notification-system/infra-redis smoke-test
//
// Exits non-zero on any assertion failure or timeout.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createRedis,
  RedisRateLimiter,
  RedisIdempotencyStore,
  RedisInAppGateway,
  InAppSubscriber,
} from "../dist/index.js";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const TIMEOUT_MS = 5_000;

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

async function testRateLimiter(redis) {
  console.log("RedisRateLimiter: consuming a 3-token bucket 4 times...");
  const tenantId = TenantId(randomUUID());
  const limiter = new RedisRateLimiter(redis, () => ({
    tenantId,
    channel: "sms",
    capacity: 3,
    refillPerSecond: 0, // no refill — makes the 4th call's denial deterministic
  }));

  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(await limiter.tryConsume(tenantId, "sms"));
  }
  assert.deepEqual(
    results,
    [true, true, true, false],
    "4th call over a 3-token bucket must be denied",
  );
  console.log("  OK — allowed 3, denied the 4th.");
}

async function testIdempotencyStore(redis) {
  console.log("RedisIdempotencyStore: find -> reserve -> find round trip...");
  const tenantId = TenantId(randomUUID());
  const key = `smoke-test-${randomUUID()}`;
  const store = new RedisIdempotencyStore(redis);

  assert.equal(
    await store.find(tenantId, key),
    null,
    "unseen key must return null",
  );

  const record = {
    payloadHash: "abc123",
    notificationRequestId: NotificationRequestId(randomUUID()),
  };
  await store.reserve(tenantId, key, record);

  const found = await store.find(tenantId, key);
  assert.deepEqual(found, record, "reserved record must round-trip exactly");
  console.log("  OK — round-tripped.");
}

async function testInAppPubSub(redis) {
  console.log(
    "RedisInAppGateway/InAppSubscriber: publish -> subscribe round trip...",
  );
  const subscriberRedis = redis.duplicate();
  const subscriber = new InAppSubscriber(subscriberRedis);

  const notificationRequestId = NotificationRequestId(randomUUID());
  const tenantId = TenantId(randomUUID());
  const recipientId = RecipientId(randomUUID());

  let resolveReceived;
  const received = new Promise((resolve) => {
    resolveReceived = resolve;
  });
  await subscriber.start((notification) => {
    if (notification.notificationRequestId !== notificationRequestId) return; // another run's leftover
    resolveReceived(notification);
  });

  const gateway = new RedisInAppGateway(redis);
  const command = {
    notificationRequestId,
    tenantId,
    recipientId,
    channel: "in_app",
    priority: "standard",
    renderedPayload: { body: "hello from the smoke test" },
    attemptNumber: 1,
  };
  const result = await gateway.send(command);
  assert.equal(result.success, true, "publish must succeed");

  const notification = await withTimeout(
    received,
    "the published in-app notification to be consumed",
  );
  assert.equal(notification.recipientId, recipientId);
  assert.equal(notification.renderedPayload.body, "hello from the smoke test");
  console.log("  OK — round-tripped.");

  await subscriber.stop();
  await subscriberRedis.quit();
}

async function main() {
  const redis = createRedis({ url: REDIS_URL });

  await testRateLimiter(redis);
  await testIdempotencyStore(redis);
  await testInAppPubSub(redis);

  console.log("\nAll infra-redis smoke tests passed.");
  await redis.quit();
}

main().catch((error) => {
  console.error("\nSMOKE TEST FAILED:", error);
  process.exitCode = 1;
});
