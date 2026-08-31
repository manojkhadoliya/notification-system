import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Recipient } from "@notification-system/domain-preferences";
import { RecipientId, TenantId } from "@notification-system/shared-kernel";
import { buildChannelPayload } from "./build-channel-payload.js";

const recipient = Recipient.create({
  id: RecipientId(randomUUID()),
  tenantId: TenantId(randomUUID()),
  phone: "+15551234567",
  pushToken: "push-token",
  email: "a@example.com",
});

describe("buildChannelPayload", () => {
  it("builds providers-sms's {to, body} shape", () => {
    const payload = buildChannelPayload(
      "sms",
      recipient,
      "order.shipped",
      "your order shipped",
    );
    assert.deepEqual(payload, {
      to: "+15551234567",
      body: "your order shipped",
    });
  });

  it("builds providers-push's {token, title, body} shape, defaulting title to notificationType", () => {
    const payload = buildChannelPayload(
      "push",
      recipient,
      "order.shipped",
      "your order shipped",
    );
    assert.deepEqual(payload, {
      token: "push-token",
      title: "order.shipped",
      body: "your order shipped",
    });
  });

  it("builds providers-email's {to, subject, body} shape, defaulting subject to notificationType", () => {
    const payload = buildChannelPayload(
      "email",
      recipient,
      "order.shipped",
      "your order shipped",
    );
    assert.deepEqual(payload, {
      to: "a@example.com",
      subject: "order.shipped",
      body: "your order shipped",
    });
  });

  it("builds a plain {body} shape for in_app", () => {
    const payload = buildChannelPayload(
      "in_app",
      recipient,
      "order.shipped",
      "your order shipped",
    );
    assert.deepEqual(payload, { body: "your order shipped" });
  });

  it("throws if called for a channel the recipient has no address for", () => {
    const noPhone = Recipient.create({
      id: RecipientId(randomUUID()),
      tenantId: TenantId(randomUUID()),
      phone: null,
    });
    assert.throws(
      () => buildChannelPayload("sms", noPhone, "order.shipped", "body"),
      /no address/,
    );
  });
});
