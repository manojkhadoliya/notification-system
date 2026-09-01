import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  BroadcastId,
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import {
  BroadcastId as makeBroadcastId,
  NotificationRequestId as makeNotificationRequestId,
  RecipientId as makeRecipientId,
  TenantId as makeTenantId,
} from "@notification-system/shared-kernel";
import { ProjectionService } from "./projection-service.js";
import { FakeNotificationRepository } from "./test-support.js";

const DELIVERY_STATUS_TOPIC = "delivery-status";
const NOW = new Date("2026-01-01T12:00:00Z");

interface AcceptedFields {
  notificationRequestId: NotificationRequestId;
  tenantId: TenantId;
  recipientId: RecipientId;
  broadcastId: BroadcastId | null;
}

function acceptedEvent(fields: AcceptedFields) {
  return {
    notificationRequestId: fields.notificationRequestId,
    status: "accepted" as const,
    attemptNumber: 0,
    occurredAt: NOW,
    tenantId: fields.tenantId,
    recipientId: fields.recipientId,
    notificationType: "order.shipped",
    idempotencyKey: "idem-1",
    channel: "sms" as const,
    broadcastId: fields.broadcastId,
    payload: { to: "+15551234567", body: "your order shipped" },
  };
}

function statusEvent(
  notificationRequestId: NotificationRequestId,
  status: "sent" | "delivered" | "failed",
  attemptNumber = 1,
) {
  return { notificationRequestId, status, attemptNumber, occurredAt: NOW };
}

function message(value: unknown) {
  return {
    topic: DELIVERY_STATUS_TOPIC,
    key: null,
    value: JSON.stringify(value),
    headers: {},
  };
}

describe("ProjectionService — accepted creates the row", () => {
  it("creates a NotificationRequest at status accepted, with everything the event carried", async () => {
    const repository = new FakeNotificationRepository();
    const service = new ProjectionService({
      notificationRepository: repository,
    });
    const notificationRequestId = makeNotificationRequestId(randomUUID());
    const tenantId = makeTenantId(randomUUID());
    const recipientId = makeRecipientId(randomUUID());

    await service.handle(
      message(
        acceptedEvent({
          notificationRequestId,
          tenantId,
          recipientId,
          broadcastId: null,
        }),
      ),
    );

    const saved = await repository.findById(notificationRequestId);
    assert.ok(saved);
    assert.equal(saved.status, "accepted");
    assert.equal(saved.tenantId, tenantId);
    assert.equal(saved.recipientId, recipientId);
    assert.equal(saved.channel, "sms");
    assert.equal(saved.idempotencyKey, "idem-1");
    assert.deepEqual(saved.payload, {
      to: "+15551234567",
      body: "your order shipped",
    });
  });

  it("carries a broadcastId back-reference through when present", async () => {
    const repository = new FakeNotificationRepository();
    const service = new ProjectionService({
      notificationRepository: repository,
    });
    const notificationRequestId = makeNotificationRequestId(randomUUID());
    const broadcastId = makeBroadcastId(randomUUID());

    await service.handle(
      message(
        acceptedEvent({
          notificationRequestId,
          tenantId: makeTenantId(randomUUID()),
          recipientId: makeRecipientId(randomUUID()),
          broadcastId,
        }),
      ),
    );

    const saved = await repository.findById(notificationRequestId);
    assert.equal(saved?.broadcastId, broadcastId);
  });

  it("a redelivered accepted is an idempotent no-op — never regresses an already-advanced row", async () => {
    const repository = new FakeNotificationRepository();
    const service = new ProjectionService({
      notificationRepository: repository,
    });
    const notificationRequestId = makeNotificationRequestId(randomUUID());
    const event = acceptedEvent({
      notificationRequestId,
      tenantId: makeTenantId(randomUUID()),
      recipientId: makeRecipientId(randomUUID()),
      broadcastId: null,
    });

    await service.handle(message(event));
    await service.handle(message(statusEvent(notificationRequestId, "sent")));
    // Redelivery of "accepted" arrives after "sent" already landed.
    await service.handle(message(event));

    const saved = await repository.findById(notificationRequestId);
    assert.equal(saved?.status, "sent", "must not regress back to accepted");
  });

  it("does not throw on malformed JSON", async () => {
    const repository = new FakeNotificationRepository();
    const service = new ProjectionService({
      notificationRepository: repository,
    });

    await service.handle({
      topic: DELIVERY_STATUS_TOPIC,
      key: null,
      value: "{not json",
      headers: {},
    });

    assert.equal(repository.savedHistory.length, 0);
  });
});

describe("ProjectionService — sent/delivered/failed advance an existing row", () => {
  it("advances accepted -> sent -> delivered, in order", async () => {
    const repository = new FakeNotificationRepository();
    const service = new ProjectionService({
      notificationRepository: repository,
    });
    const notificationRequestId = makeNotificationRequestId(randomUUID());

    await service.handle(
      message(
        acceptedEvent({
          notificationRequestId,
          tenantId: makeTenantId(randomUUID()),
          recipientId: makeRecipientId(randomUUID()),
          broadcastId: null,
        }),
      ),
    );
    await service.handle(message(statusEvent(notificationRequestId, "sent")));

    let saved = await repository.findById(notificationRequestId);
    assert.equal(saved?.status, "sent");

    await service.handle(
      message(statusEvent(notificationRequestId, "delivered")),
    );

    saved = await repository.findById(notificationRequestId);
    assert.equal(saved?.status, "delivered");
  });

  it("logs and skips, without throwing, when no row exists yet for the notificationRequestId", async () => {
    const repository = new FakeNotificationRepository();
    const service = new ProjectionService({
      notificationRepository: repository,
    });
    const notificationRequestId = makeNotificationRequestId(randomUUID());

    await service.handle(message(statusEvent(notificationRequestId, "sent")));

    assert.equal(repository.savedHistory.length, 0);
    assert.equal(await repository.findById(notificationRequestId), null);
  });

  it("discards a regressive transition rather than applying it", async () => {
    const repository = new FakeNotificationRepository();
    const service = new ProjectionService({
      notificationRepository: repository,
    });
    const notificationRequestId = makeNotificationRequestId(randomUUID());

    await service.handle(
      message(
        acceptedEvent({
          notificationRequestId,
          tenantId: makeTenantId(randomUUID()),
          recipientId: makeRecipientId(randomUUID()),
          broadcastId: null,
        }),
      ),
    );
    await service.handle(message(statusEvent(notificationRequestId, "sent")));
    await service.handle(
      message(statusEvent(notificationRequestId, "delivered")),
    );
    // A redelivered "sent" arrives after "delivered" already landed.
    await service.handle(message(statusEvent(notificationRequestId, "sent")));

    const saved = await repository.findById(notificationRequestId);
    assert.equal(
      saved?.status,
      "delivered",
      "must stay at the terminal status",
    );
  });

  it("does not throw on malformed JSON", async () => {
    const repository = new FakeNotificationRepository();
    const service = new ProjectionService({
      notificationRepository: repository,
    });

    await service.handle({
      topic: DELIVERY_STATUS_TOPIC,
      key: null,
      value: "{not json",
      headers: {},
    });

    assert.equal(repository.savedHistory.length, 0);
  });
});
