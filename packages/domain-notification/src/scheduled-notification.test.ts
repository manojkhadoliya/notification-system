import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BroadcastId,
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import { ScheduledNotification } from "./scheduled-notification.js";

const tenantId = TenantId("66666666-6666-6666-6666-666666666666");
const recipientId = RecipientId("77777777-7777-7777-7777-777777777777");
const notificationRequestId = NotificationRequestId(
  "88888888-8888-8888-8888-888888888888",
);

function schedule(dueAt: Date): ScheduledNotification {
  return ScheduledNotification.schedule({
    id: "sn1",
    notificationRequestId,
    tenantId,
    recipientId,
    notificationType: "digest",
    payload: {},
    priority: "standard",
    dueAt,
  });
}

test("a fresh row is pending and not claimed", () => {
  const sn = schedule(new Date());
  assert.equal(sn.status, "pending");
  assert.equal(sn.claimedAt, null);
});

test("isDue is true once dueAt has passed and status is pending", () => {
  const past = schedule(new Date(Date.now() - 1000));
  assert.equal(past.isDue(new Date()), true);
});

test("isDue is false before dueAt", () => {
  const future = schedule(new Date(Date.now() + 60_000));
  assert.equal(future.isDue(new Date()), false);
});

test("claim() transitions pending -> claimed", () => {
  const claimed = schedule(new Date()).claim();
  assert.equal(claimed.status, "claimed");
  assert.notEqual(claimed.claimedAt, null);
});

test("claim() throws if already claimed", () => {
  const claimed = schedule(new Date()).claim();
  assert.throws(() => claimed.claim());
});

test("markEmitted() transitions claimed -> emitted", () => {
  const emitted = schedule(new Date()).claim().markEmitted();
  assert.equal(emitted.status, "emitted");
});

test("markEmitted() throws if not yet claimed", () => {
  const sn = schedule(new Date());
  assert.throws(() => sn.markEmitted());
});

test("isDue is false once claimed, even if past due — a poller shard owns it now", () => {
  const claimed = schedule(new Date(Date.now() - 1000)).claim();
  assert.equal(claimed.isDue(new Date()), false);
});

test("preserves the original notificationRequestId it defers, distinct from its own row id", () => {
  const sn = schedule(new Date());
  assert.equal(sn.id, "sn1");
  assert.equal(sn.notificationRequestId, notificationRequestId);
});

test("broadcastId defaults to null for a non-broadcast deferral", () => {
  const sn = schedule(new Date());
  assert.equal(sn.broadcastId, null);
});

test("preserves an explicit broadcastId for a deferred fanout recipient", () => {
  const sn = ScheduledNotification.schedule({
    id: "sn1",
    notificationRequestId,
    tenantId,
    recipientId,
    notificationType: "digest",
    payload: {},
    priority: "standard",
    broadcastId: BroadcastId("99999999-9999-9999-9999-999999999999"),
    dueAt: new Date(),
  });
  assert.equal(sn.broadcastId, "99999999-9999-9999-9999-999999999999");
});

test("idempotencyKey defaults to null", () => {
  const sn = schedule(new Date());
  assert.equal(sn.idempotencyKey, null);
});

test("preserves an explicit idempotencyKey from a Door-1-originated deferral", () => {
  const sn = ScheduledNotification.schedule({
    id: "sn1",
    notificationRequestId,
    tenantId,
    recipientId,
    notificationType: "digest",
    payload: {},
    priority: "standard",
    idempotencyKey: "client-key-1",
    dueAt: new Date(),
  });
  assert.equal(sn.idempotencyKey, "client-key-1");
});

test("dueMinute is derived from dueAt", () => {
  const dueAt = new Date("2026-01-01T00:00:00Z");
  const sn = schedule(dueAt);
  assert.equal(sn.dueMinute, Math.floor(dueAt.getTime() / 60_000));
});
