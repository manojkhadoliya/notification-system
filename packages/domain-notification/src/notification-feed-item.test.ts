import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  NotificationRequestId,
  RecipientId,
} from "@notification-system/shared-kernel";
import { NotificationFeedItem } from "./notification-feed-item.js";

function write(): NotificationFeedItem {
  return NotificationFeedItem.write({
    id: randomUUID(),
    recipientId: RecipientId(randomUUID()),
    notificationRequestId: NotificationRequestId(randomUUID()),
    summary: "your order shipped",
  });
}

test("write() starts unread", () => {
  const item = write();
  assert.equal(item.readAt, null);
});

test("markRead() sets readAt", () => {
  const item = write();
  const at = new Date("2026-01-01T00:00:00.000Z");
  const read = item.markRead(at);
  assert.equal(read.readAt?.toISOString(), at.toISOString());
});

test("markRead() is a no-op once already read, keeping the original readAt", () => {
  const item = write();
  const firstReadAt = new Date("2026-01-01T00:00:00.000Z");
  const read = item.markRead(firstReadAt);
  const readAgain = read.markRead(new Date("2026-01-02T00:00:00.000Z"));
  assert.equal(readAgain.readAt?.toISOString(), firstReadAt.toISOString());
});
