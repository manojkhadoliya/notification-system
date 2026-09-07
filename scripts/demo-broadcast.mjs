#!/usr/bin/env node
// docs/local-development.md#3.5 / docs/roadmap.md's "docker compose up
// demo" item, scenario 1 of 2: a broadcast (Door 2 → fan-out → many
// recipients) run against the whole live stack — not one service in
// isolation like every services/*/scripts/smoke-test.mjs, but the real
// multi-hop path: services/fanout-expander resolves the audience and
// expands it into one events.standard per recipient, services/router
// dispatches each independently, services/worker-sms delivers each via
// the mock SMS gateway. Not part of the automated test suite (no live
// infra in CI yet — see roadmap.md's integration-tests item); run this
// by hand once the whole stack is up (either Phase A's ten host
// processes, or Phase B's `docker compose up -d` — see
// local-development.md):
//
//   node scripts/demo-broadcast.mjs
//
// Seeds its own Tenant + N Recipients directly via Prisma, publishes one
// BroadcastRequest onto events.broadcast via KafkaMessageBroker
// (the same "producer library (Door 2)" pattern
// services/fanout-expander's own smoke test uses — see its header
// comment for why there's no separate package/HTTP endpoint for this),
// then polls Postgres until every recipient's own NotificationRequest
// row reaches "sent" — the real terminal status a channel worker ever
// publishes in Phase 1 (no provider webhook exists yet to confirm actual
// carrier delivery, so "delivered" is never reached outside
// services/projection-notification's own smoke test, which fabricates
// all three statuses by hand to test the projection in isolation).
// Exits non-zero on any assertion failure or timeout.

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
const RECIPIENT_COUNT = 5;
const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

// Closed in the shared `.finally()` below, not just on the success
// path — see every services/*/scripts/smoke-test.mjs's own note on why:
// a failed assertion or a pollUntil() timeout used to skip straight to
// catch() above, leaving this open Kafka connection keeping the event
// loop (and this process) alive forever instead of actually exiting
// non-zero.
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
    data: { id: tenantId, name: "demo-broadcast-tenant" },
  });

  const recipientIds = [];
  for (let i = 0; i < RECIPIENT_COUNT; i++) {
    const recipientId = randomUUID();
    recipientIds.push(recipientId);
    // Phone only, no Preference row — decideChannel's auto-pick order
    // (shared-kernel's CHANNELS: sms, push, email, in_app) lands on sms
    // for every one of these, and "no Preference row" means opted-in by
    // default (see services/router/src/routing.ts's own doc comment).
    await prisma.recipient.create({
      data: {
        id: recipientId,
        tenantId,
        phone: `+1555${String(i).padStart(7, "0")}`,
      },
    });
  }
  console.log(
    `Seeded 1 tenant + ${RECIPIENT_COUNT} recipients (sms addresses only).`,
  );

  const broadcastId = randomUUID();
  const kafka = createKafka({
    brokers: KAFKA_BROKERS,
    clientId: "demo-broadcast",
  });
  producer = await createKafkaProducer(kafka);
  const broker = new KafkaMessageBroker(producer);

  console.log(
    `Publishing a BroadcastRequest (audience: all_recipients) onto events.broadcast — broadcastId ${broadcastId}...`,
  );
  await broker.publishBroadcast({
    id: broadcastId,
    tenantId,
    audienceDescriptor: { kind: "all_recipients" },
    notificationType: "digest",
    payload: { message: "demo broadcast — see scripts/demo-broadcast.mjs" },
    priority: "standard",
    createdAt: new Date(),
  });

  console.log(
    `Waiting up to ${TIMEOUT_MS}ms for services/fanout-expander to resolve + expand, ` +
      "services/router to dispatch each independently, and services/worker-sms " +
      `to deliver all ${RECIPIENT_COUNT}...`,
  );
  const rows = await pollUntil(async () => {
    const found = await prisma.notificationRequest.findMany({
      where: { broadcastId },
    });
    const failed = found.filter((r) => r.status === "failed");
    if (failed.length > 0) {
      throw new Error(
        `${failed.length} of ${RECIPIENT_COUNT} broadcast recipients ended in status "failed": ` +
          failed.map((r) => r.id).join(", "),
      );
    }
    if (
      found.length === RECIPIENT_COUNT &&
      found.every((r) => r.status === "sent")
    ) {
      return found;
    }
    return undefined;
  }, `all ${RECIPIENT_COUNT} broadcast recipients to reach status "sent"`);

  console.log(`\nAll ${RECIPIENT_COUNT} recipients reached "sent":`);
  for (const row of rows.sort((a, b) =>
    a.recipientId.localeCompare(b.recipientId),
  )) {
    console.log(`  ${row.recipientId} -> ${row.id} (${row.status})`);
  }

  assert.deepEqual(
    rows.map((r) => r.recipientId).sort(),
    [...recipientIds].sort(),
  );
  assert.equal(new Set(rows.map((r) => r.id)).size, RECIPIENT_COUNT);
  for (const row of rows) {
    assert.equal(row.broadcastId, broadcastId);
    assert.equal(row.channel, "sms");
  }

  console.log(
    "\nBroadcast demo complete: one BroadcastRequest -> fan-out-expander -> " +
      `${RECIPIENT_COUNT} independent notifications, each routed, dispatched, and ` +
      "delivered through the mock SMS gateway.",
  );
}

main()
  .catch((error) => {
    console.error("\nDEMO FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (producer) await producer.disconnect();
    await prisma.$disconnect();
  });
