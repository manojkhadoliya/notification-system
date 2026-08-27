import { test } from "node:test";
import assert from "node:assert/strict";
import { RecipientId, TenantId } from "@notification-system/shared-kernel";
import { ScheduledNotification } from "./scheduled-notification.js";

const tenantId = TenantId("66666666-6666-6666-6666-666666666666");
const recipientId = RecipientId("77777777-7777-7777-7777-777777777777");

function schedule(dueAt: Date): ScheduledNotification {
  return ScheduledNotification.schedule({
    id: "sn1",
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

test("dueMinute is derived from dueAt", () => {
  const dueAt = new Date("2026-01-01T00:00:00Z");
  const sn = schedule(dueAt);
  assert.equal(sn.dueMinute, Math.floor(dueAt.getTime() / 60_000));
});
