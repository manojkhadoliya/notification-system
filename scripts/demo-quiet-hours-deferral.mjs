#!/usr/bin/env node
// docs/local-development.md#3.5 / docs/roadmap.md's "docker compose up
// demo" item, scenario 2 of 2: a quiet-hours deferral that
// services/scheduler later re-emits — run against the whole live stack,
// proving the real deferral timing, not a synthetic one. Not part of the
// automated test suite (no live infra in CI yet — see roadmap.md's
// integration-tests item); run this by hand once the whole stack is up
// (either Phase A's ten host processes, or Phase B's `docker compose up
// -d` — see local-development.md):
//
//   node scripts/demo-quiet-hours-deferral.mjs
//
// Seeds its own Tenant + Recipient + a Preference whose quiet hours
// cover right now and end ~2 minutes out, publishes one NotificationEvent
// onto events.standard (the same "producer library (Door 1)" pattern
// POST /v1/notifications itself uses downstream of the HTTP layer — see
// services/router/scripts/smoke-test.mjs's own header comment), then:
//
//   1. confirms services/router deferred it — no NotificationRequest row
//      at all yet, only a pending ScheduledNotification (deferring
//      writes nothing to the events/delivery-status backbone; see
//      RouterService.defer's doc comment) — proving this isn't just an
//      immediate dispatch that happened to look right;
//   2. waits out the real quiet-hours window (this really does take
//      ~2 minutes — deliberately not shortened to a synthetic instant,
//      since the point is to watch services/scheduler's poller actually
//      catch it once due, not fake the wait);
//   3. confirms the row reaches "sent" under the *same*
//      notificationRequestId the original event carried (not a new one —
//      see ScheduledNotification.schedule's own doc comment on why that
//      would otherwise make a deferred request permanently unqueryable).
//
// Exits non-zero on any assertion failure or timeout.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  minutesToPgTime,
  PrismaClient,
} from "@notification-system/infra-postgres";
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
// How far past "now" quiet hours end — long enough to comfortably
// survive the few seconds of latency between computing "now" below and
// services/router actually consuming the event, short enough that
// watching this by hand doesn't take forever. services/router computes
// "now" in UTC (Date.prototype.getUTCHours/Minutes — see its own doc
// comment on why: no recipient timezone exists in the domain model yet),
// so this does too.
const QUIET_HOURS_WINDOW_MINUTES = 2;
const DEFER_CHECK_TIMEOUT_MS = 5_000;
const REEMIT_TIMEOUT_MS = (QUIET_HOURS_WINDOW_MINUTES + 2) * 60_000;
const POLL_INTERVAL_MS = 1_000;

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

// Closed in the shared `.finally()` below, not just on the success
// path — see every services/*/scripts/smoke-test.mjs's own note on why.
let producer;

async function pollUntil(fn, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function formatClock(minuteOfDay) {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

async function main() {
  const tenantId = randomUUID();
  const recipientId = randomUUID();
  await prisma.tenant.create({
    data: { id: tenantId, name: "demo-quiet-hours-tenant" },
  });
  await prisma.recipient.create({
    data: { id: recipientId, tenantId, phone: "+15550001234" },
  });

  const now = new Date();
  const nowMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
  // 1 minute before "now" to now + window, wrapping past midnight the
  // same way quiet-hours.ts's own isWithinQuietHours does — a window
  // that already covers "now" the instant the row is written, not one
  // that starts covering it only later.
  const startMinute = (nowMinute - 1 + 1440) % 1440;
  const endMinute = (nowMinute + QUIET_HOURS_WINDOW_MINUTES) % 1440;

  await prisma.preference.create({
    data: {
      id: randomUUID(),
      recipientId,
      channel: "sms",
      notificationType: "order.shipped",
      optedIn: true,
      quietHoursStart: minutesToPgTime(startMinute),
      quietHoursEnd: minutesToPgTime(endMinute),
      fallbackOrder: [],
    },
  });
  console.log(
    `Seeded a Preference with quiet hours ${formatClock(startMinute)}-${formatClock(endMinute)} UTC ` +
      `(now: ${formatClock(nowMinute)} UTC) — covers "now", ends in ~${QUIET_HOURS_WINDOW_MINUTES} minutes.`,
  );

  const notificationRequestId = randomUUID();
  const kafka = createKafka({
    brokers: KAFKA_BROKERS,
    clientId: "demo-quiet-hours-deferral",
  });
  producer = await createKafkaProducer(kafka);
  const broker = new KafkaMessageBroker(producer);

  console.log(
    `\nPublishing a NotificationEvent onto events.standard — notificationRequestId ${notificationRequestId}. ` +
      "Expecting services/router to DEFER this, not dispatch it immediately...",
  );
  await broker.publishEvent({
    notificationRequestId,
    tenantId,
    recipientId,
    notificationType: "order.shipped",
    channel: "sms",
    templateVersionId: null,
    payloadRef: { message: "quiet-hours deferral demo" },
    priority: "standard",
    broadcastId: null,
  });

  // Give services/router a moment to actually consume and process the
  // event, then confirm the *absence* of an immediate dispatch — a
  // ScheduledNotification row, and specifically no NotificationRequest
  // row at all yet (deferring publishes nothing to the event backbone;
  // see RouterService.defer's doc comment).
  const scheduled = await pollUntil(
    async () => {
      const row = await prisma.scheduledNotification.findFirst({
        where: { notificationRequestId },
      });
      return row ?? undefined;
    },
    "a ScheduledNotification row for this notificationRequestId",
    DEFER_CHECK_TIMEOUT_MS,
  );

  assert.equal(scheduled.status, "pending");
  assert.equal(scheduled.recipientId, recipientId);
  const immediateRow = await prisma.notificationRequest.findUnique({
    where: { id: notificationRequestId },
  });
  assert.equal(
    immediateRow,
    null,
    "expected no NotificationRequest row yet — this should be deferred, not dispatched",
  );
  console.log(
    `Confirmed deferred: ScheduledNotification ${scheduled.id} is "pending", due at ` +
      `${scheduled.dueAt.toISOString()} — no NotificationRequest row exists yet.`,
  );

  console.log(
    `\nWaiting for quiet hours to end and services/scheduler's poller to claim + re-emit ` +
      `(up to ${Math.round(REEMIT_TIMEOUT_MS / 1000)}s — this really does take a couple of minutes)...`,
  );
  const finalRow = await pollUntil(
    async () => {
      const row = await prisma.notificationRequest.findUnique({
        where: { id: notificationRequestId },
      });
      if (row?.status === "failed") {
        throw new Error(
          `NotificationRequest ${notificationRequestId} ended in status "failed"`,
        );
      }
      return row?.status === "sent" ? row : undefined;
    },
    'the re-emitted NotificationRequest to reach status "sent"',
    REEMIT_TIMEOUT_MS,
  );

  console.log(
    `\nRe-emitted and delivered: NotificationRequest ${finalRow.id} reached "sent" — ` +
      "same notificationRequestId the original (deferred) event carried.",
  );

  assert.equal(finalRow.id, notificationRequestId);
  assert.equal(finalRow.recipientId, recipientId);
  assert.equal(finalRow.channel, "sms");

  const emittedScheduled = await prisma.scheduledNotification.findUnique({
    where: { id: scheduled.id },
  });
  assert.equal(emittedScheduled.status, "emitted");

  console.log(
    "\nQuiet-hours deferral demo complete: deferred while quiet hours were active, " +
      "re-emitted under the same notificationRequestId once they ended, delivered normally.",
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
