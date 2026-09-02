#!/usr/bin/env node
// Round-trips a real Redis pub/sub message through a live
// services/inapp-gateway process — the thing ConnectionRegistry's/
// notify.ts's/server.ts's unit tests can't prove (a real Redis
// subscription, a real WebSocket upgrade over the network, not just a
// loopback connection inside the same process). Not part of the
// automated test suite (no live infra in CI yet — see roadmap.md's
// integration-tests item); run this by hand:
//
//   pnpm compose:up
//   pnpm --filter @notification-system/inapp-gateway build
//   pnpm --filter @notification-system/inapp-gateway start &   (reads .env — see .env.example)
//   pnpm --filter @notification-system/inapp-gateway smoke-test
//
// Connects a real WebSocket client carrying a fresh recipientId, then
// publishes an InAppNotification directly onto Redis's
// INAPP_PUBSUB_CHANNEL (bypassing services/worker-inapp — this is a
// gateway-level test, same spirit as worker-inapp's own smoke test
// publishing straight onto command.in_app), and asserts the socket
// receives it. Exits non-zero on any assertion failure or timeout.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  createRedis,
  INAPP_PUBSUB_CHANNEL,
} from "@notification-system/infra-redis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const HOST = process.env.SMOKE_TEST_HOST ?? "127.0.0.1";
const PORT = process.env.PORT ?? 3001;
// Matches server.ts's FEED_STREAM_PATH — kept as a literal here rather
// than imported, since this script runs against compiled dist/ output
// and no other smoke-test.mjs in the repo imports its own package's
// dist (see eslint.config.mjs's ignore comment for why).
const FEED_STREAM_PATH = "/v1/feed/stream";
const TIMEOUT_MS = 15_000;

// Closed in the shared `.finally()` below, not just on the success path —
// see that block's comment for why a failure/timeout used to leave a
// zombie process holding these open forever.
let socket;
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
  const recipientId = randomUUID();
  const notificationRequestId = randomUUID();

  console.log("Opening a WebSocket connection to services/inapp-gateway...");
  socket = new WebSocket(
    `ws://${HOST}:${PORT}${FEED_STREAM_PATH}?recipientId=${recipientId}`,
  );
  await withTimeout(
    new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    "the WebSocket connection to open",
  );

  const messageReceived = withTimeout(
    new Promise((resolve) => {
      socket.on("message", (raw) => resolve(JSON.parse(String(raw))));
    }),
    "a pub/sub notification pushed down the socket",
  );

  redis = createRedis({ url: REDIS_URL });
  console.log(`Publishing directly onto ${INAPP_PUBSUB_CHANNEL}...`);
  await redis.publish(
    INAPP_PUBSUB_CHANNEL,
    JSON.stringify({
      notificationRequestId,
      tenantId: randomUUID(),
      recipientId,
      renderedPayload: { body: "smoke test" },
    }),
  );

  const message = await messageReceived;
  assert.equal(message.notificationRequestId, notificationRequestId);
  assert.equal(message.recipientId, recipientId);
  assert.equal(message.renderedPayload.body, "smoke test");

  console.log("\nAll services/inapp-gateway smoke tests passed.");
}

main()
  .catch((error) => {
    console.error("\nSMOKE TEST FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Runs on every path, not just success — a failed assertion or a
    // withTimeout() rejection used to skip straight to catch() above,
    // leaving the open WebSocket/Redis connections keeping the event
    // loop (and this process) alive forever instead of actually
    // exiting non-zero as this script's own header promises. Found by
    // hitting it directly (a different service's smoke test): a
    // failing run just hung.
    if (socket) socket.close();
    if (redis) await redis.quit();
  });
