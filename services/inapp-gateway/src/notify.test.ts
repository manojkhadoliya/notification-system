import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import type { InAppNotification } from "@notification-system/infra-redis";
import { ConnectionRegistry, type Socket } from "./connection-registry.js";
import { pushToRegistry } from "./notify.js";

function fakeSocket(): Socket & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(data: string) {
      sent.push(data);
    },
  };
}

function sampleNotification(
  overrides: Partial<InAppNotification> = {},
): InAppNotification {
  return {
    notificationRequestId: NotificationRequestId("request-1"),
    tenantId: TenantId("tenant-1"),
    recipientId: RecipientId("recipient-1"),
    renderedPayload: { body: "your order shipped" },
    ...overrides,
  };
}

test("pushes the JSON-encoded notification to every socket held for its recipientId", () => {
  const registry = new ConnectionRegistry();
  const socket = fakeSocket();
  registry.add(RecipientId("recipient-1"), socket);
  const notification = sampleNotification();

  const reached = pushToRegistry(registry, notification);

  assert.equal(reached, 1);
  assert.deepEqual(JSON.parse(socket.sent[0] as string), notification);
});

test("a recipient with no live connection reaches nobody, without throwing", () => {
  const registry = new ConnectionRegistry();

  const reached = pushToRegistry(registry, sampleNotification());

  assert.equal(reached, 0);
});

test("never reaches a socket held for a different recipient", () => {
  const registry = new ConnectionRegistry();
  const other = fakeSocket();
  registry.add(RecipientId("someone-else"), other);

  pushToRegistry(registry, sampleNotification({ recipientId: RecipientId("recipient-1") }));

  assert.deepEqual(other.sent, []);
});
