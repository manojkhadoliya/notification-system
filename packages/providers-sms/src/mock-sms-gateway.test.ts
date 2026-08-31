import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ChannelCommand } from "@notification-system/domain-notification";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import { MockSmsGateway } from "./mock-sms-gateway.js";

const command: ChannelCommand = {
  notificationRequestId: NotificationRequestId(randomUUID()),
  tenantId: TenantId(randomUUID()),
  recipientId: RecipientId(randomUUID()),
  channel: "sms",
  priority: "standard",
  renderedPayload: { to: "+15551234567", body: "hello" },
  attemptNumber: 1,
};

describe("MockSmsGateway", () => {
  it("always succeeds with successRate 1 (the default)", async () => {
    const gateway = new MockSmsGateway();
    const result = await gateway.send(command);
    assert.equal(result.success, true);
  });

  it("always fails, retryably, with successRate 0", async () => {
    const gateway = new MockSmsGateway({ successRate: 0 });
    const result = await gateway.send(command);
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, true);
  });

  it("consults the injected random() against successRate deterministically", async () => {
    const gateway = new MockSmsGateway({ successRate: 0.5, random: () => 0.4 });
    const below = await gateway.send(command);
    assert.equal(below.success, true); // 0.4 < 0.5 -> success

    const gatewayAbove = new MockSmsGateway({
      successRate: 0.5,
      random: () => 0.6,
    });
    const above = await gatewayAbove.send(command);
    assert.equal(above.success, false); // 0.6 >= 0.5 -> failure
  });

  it("rejects a malformed renderedPayload as not retryable", async () => {
    const gateway = new MockSmsGateway();
    const result = await gateway.send({
      ...command,
      renderedPayload: { body: "no `to` field" },
    });
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, false);
  });
});
