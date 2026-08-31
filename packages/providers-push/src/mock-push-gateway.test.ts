import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ChannelCommand } from "@notification-system/domain-notification";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import { MockPushGateway } from "./mock-push-gateway.js";

const command: ChannelCommand = {
  notificationRequestId: NotificationRequestId(randomUUID()),
  tenantId: TenantId(randomUUID()),
  recipientId: RecipientId(randomUUID()),
  channel: "push",
  priority: "standard",
  renderedPayload: { token: "fcm-token", title: "Hi", body: "hello" },
  attemptNumber: 1,
};

describe("MockPushGateway", () => {
  it("always succeeds with successRate 1 (the default)", async () => {
    const gateway = new MockPushGateway();
    const result = await gateway.send(command);
    assert.equal(result.success, true);
  });

  it("always fails, retryably, with successRate 0", async () => {
    const gateway = new MockPushGateway({ successRate: 0 });
    const result = await gateway.send(command);
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, true);
  });

  it("consults the injected random() against successRate deterministically", async () => {
    const below = await new MockPushGateway({
      successRate: 0.5,
      random: () => 0.4,
    }).send(command);
    assert.equal(below.success, true); // 0.4 < 0.5 -> success

    const above = await new MockPushGateway({
      successRate: 0.5,
      random: () => 0.6,
    }).send(command);
    assert.equal(above.success, false); // 0.6 >= 0.5 -> failure
  });

  it("rejects a malformed renderedPayload as not retryable", async () => {
    const gateway = new MockPushGateway();
    const result = await gateway.send({
      ...command,
      renderedPayload: { title: "no token" },
    });
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, false);
  });
});
