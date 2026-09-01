import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TemplateVersion } from "@notification-system/domain-templates";
import {
  Preference,
  Recipient,
  quietHoursFromClock,
} from "@notification-system/domain-preferences";
import {
  NotificationRequestId,
  RecipientId,
  TemplateId,
  TemplateVersionId,
  TenantId,
} from "@notification-system/shared-kernel";
import type { NotificationEvent } from "@notification-system/domain-notification";
import { RouterService } from "./router-service.js";
import {
  FakeMessageBroker,
  FakePreferenceRepository,
  FakeScheduledNotificationRepository,
  FakeTemplateRepository,
} from "./test-support.js";

const NOW = new Date("2026-01-01T12:00:00.000Z"); // noon UTC — outside any quiet-hours window used below

function makeEvent(
  overrides: Partial<NotificationEvent> = {},
): NotificationEvent {
  return {
    notificationRequestId: NotificationRequestId(randomUUID()),
    tenantId: TenantId(randomUUID()),
    recipientId: RecipientId(randomUUID()),
    notificationType: "order.shipped",
    channel: "sms",
    templateVersionId: null,
    payloadRef: { message: "your order shipped" },
    priority: "standard",
    broadcastId: null,
    idempotencyKey: "idempotency-key-1",
    ...overrides,
  };
}

function makeDeps() {
  const preferenceRepository = new FakePreferenceRepository();
  const templateRepository = new FakeTemplateRepository();
  const scheduledNotificationRepository =
    new FakeScheduledNotificationRepository();
  const messageBroker = new FakeMessageBroker();
  return {
    preferenceRepository,
    templateRepository,
    scheduledNotificationRepository,
    messageBroker,
  };
}

describe("RouterService.handle", () => {
  it("dispatches using raw payload.message as the body when no templateVersionId is given", async () => {
    const deps = makeDeps();
    const event = makeEvent({ tenantId: TenantId(randomUUID()) });
    const recipient = Recipient.create({
      id: event.recipientId,
      tenantId: event.tenantId,
      phone: "+15551234567",
    });
    deps.preferenceRepository.seedRecipient(recipient);

    const service = new RouterService(deps, () => NOW);
    await service.handle(event);

    assert.equal(deps.messageBroker.publishedCommands.length, 1);
    const command = deps.messageBroker.publishedCommands[0]!;
    assert.equal(command.channel, "sms");
    assert.deepEqual(command.renderedPayload, {
      to: "+15551234567",
      body: "your order shipped",
    });
    assert.equal(command.attemptNumber, 1);

    assert.equal(deps.messageBroker.deliveryStatusEvents.length, 1);
    const status = deps.messageBroker.deliveryStatusEvents[0]!;
    assert.equal(status.status, "accepted");
    assert.equal(status.attemptNumber, 0);
    assert.equal(status.notificationRequestId, event.notificationRequestId);
    if (status.status !== "accepted") {
      throw new Error("unreachable — asserted above");
    }
    // Everything services/projection-notification needs to create the
    // NotificationRequest row — the resolved channel above all, since
    // NotificationEvent.channel can be null but this can't be.
    assert.equal(status.tenantId, event.tenantId);
    assert.equal(status.recipientId, event.recipientId);
    assert.equal(status.notificationType, event.notificationType);
    assert.equal(status.idempotencyKey, event.idempotencyKey);
    assert.equal(status.channel, "sms");
    assert.equal(status.broadcastId, event.broadcastId);
    assert.deepEqual(status.payload, command.renderedPayload);
  });

  it("falls back to JSON.stringify(payloadRef) when there's no .message and no template", async () => {
    const deps = makeDeps();
    const event = makeEvent({ payloadRef: { orderId: "4471" } });
    deps.preferenceRepository.seedRecipient(
      Recipient.create({
        id: event.recipientId,
        tenantId: event.tenantId,
        phone: "+1",
      }),
    );

    const service = new RouterService(deps, () => NOW);
    await service.handle(event);

    const command = deps.messageBroker.publishedCommands[0]!;
    assert.equal(
      command.renderedPayload.body,
      JSON.stringify({ orderId: "4471" }),
    );
  });

  it("renders a template when templateVersionId is given", async () => {
    const deps = makeDeps();
    const templateVersionId = TemplateVersionId(randomUUID());
    deps.templateRepository.seedVersion(
      TemplateVersion.publish({
        id: templateVersionId,
        templateId: TemplateId(randomUUID()),
        locale: "en-US",
        version: 1,
        content: "Hi {{name}}, your order {{orderId}} shipped.",
      }),
    );
    const event = makeEvent({
      templateVersionId,
      payloadRef: { name: "Alex", orderId: "4471" },
    });
    deps.preferenceRepository.seedRecipient(
      Recipient.create({
        id: event.recipientId,
        tenantId: event.tenantId,
        phone: "+1",
      }),
    );

    const service = new RouterService(deps, () => NOW);
    await service.handle(event);

    assert.equal(
      deps.messageBroker.publishedCommands[0]!.renderedPayload.body,
      "Hi Alex, your order 4471 shipped.",
    );
  });

  it("skips (no command, no delivery-status) when templateVersionId doesn't resolve to a version", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      templateVersionId: TemplateVersionId(randomUUID()),
    });
    deps.preferenceRepository.seedRecipient(
      Recipient.create({
        id: event.recipientId,
        tenantId: event.tenantId,
        phone: "+1",
      }),
    );

    const service = new RouterService(deps, () => NOW);
    await service.handle(event);

    assert.equal(deps.messageBroker.publishedCommands.length, 0);
    assert.equal(deps.messageBroker.deliveryStatusEvents.length, 0);
  });

  it("defers into ScheduledNotificationRepository during quiet hours, without publishing anything", async () => {
    const deps = makeDeps();
    const event = makeEvent();
    deps.preferenceRepository.seedRecipient(
      Recipient.create({
        id: event.recipientId,
        tenantId: event.tenantId,
        phone: "+1",
      }),
    );
    deps.preferenceRepository.seedPreference(
      Preference.create({
        id: randomUUID(),
        recipientId: event.recipientId,
        channel: "sms",
        notificationType: event.notificationType,
        optedIn: true,
        quietHours: quietHoursFromClock(10, 0, 14, 0), // 10:00-14:00 UTC, NOW is noon
      }),
    );

    // Zero jitter: this test asserts an exact dueAt, so the random
    // default (see MAX_DEFER_JITTER_MS) would make it flaky — the
    // "defers with jitter" test below covers the non-zero case.
    const service = new RouterService(
      deps,
      () => NOW,
      () => 0,
    );
    await service.handle(event);

    assert.equal(deps.scheduledNotificationRepository.saved.length, 1);
    const scheduled = deps.scheduledNotificationRepository.saved[0]!;
    assert.equal(scheduled.dueAt.toISOString(), "2026-01-01T14:00:00.000Z");
    assert.equal(scheduled.notificationType, event.notificationType);
    // Preserved, not re-minted — services/scheduler must re-emit under
    // the same id the client was handed at 202 Accepted time.
    assert.equal(scheduled.notificationRequestId, event.notificationRequestId);
    assert.equal(deps.messageBroker.publishedCommands.length, 0);
    assert.equal(deps.messageBroker.deliveryStatusEvents.length, 0);
  });

  it("defers with jitter added forward, never subtracted, from the computed dueAt", async () => {
    const deps = makeDeps();
    const event = makeEvent();
    deps.preferenceRepository.seedRecipient(
      Recipient.create({
        id: event.recipientId,
        tenantId: event.tenantId,
        phone: "+1",
      }),
    );
    deps.preferenceRepository.seedPreference(
      Preference.create({
        id: randomUUID(),
        recipientId: event.recipientId,
        channel: "sms",
        notificationType: event.notificationType,
        optedIn: true,
        quietHours: quietHoursFromClock(10, 0, 14, 0), // 10:00-14:00 UTC, NOW is noon
      }),
    );

    const service = new RouterService(
      deps,
      () => NOW,
      () => 5_000,
    );
    await service.handle(event);

    const scheduled = deps.scheduledNotificationRepository.saved[0]!;
    assert.equal(scheduled.dueAt.toISOString(), "2026-01-01T14:00:05.000Z");
  });

  it("does nothing when the recipient doesn't exist", async () => {
    const deps = makeDeps();
    const event = makeEvent();

    const service = new RouterService(deps, () => NOW);
    await service.handle(event);

    assert.equal(deps.messageBroker.publishedCommands.length, 0);
    assert.equal(deps.messageBroker.deliveryStatusEvents.length, 0);
    assert.equal(deps.scheduledNotificationRepository.saved.length, 0);
  });

  it("treats a recipient belonging to a different tenant as not found", async () => {
    const deps = makeDeps();
    const event = makeEvent();
    // Seeded under a *different* tenantId than the event carries.
    deps.preferenceRepository.seedRecipient(
      Recipient.create({
        id: event.recipientId,
        tenantId: TenantId(randomUUID()),
        phone: "+1",
      }),
    );

    const service = new RouterService(deps, () => NOW);
    await service.handle(event);

    assert.equal(deps.messageBroker.publishedCommands.length, 0);
  });

  it("auto-picks a channel when the event has no explicit channel override", async () => {
    const deps = makeDeps();
    const event = makeEvent({ channel: null });
    deps.preferenceRepository.seedRecipient(
      Recipient.create({
        id: event.recipientId,
        tenantId: event.tenantId,
        phone: null,
        pushToken: "push-token",
      }),
    );

    const service = new RouterService(deps, () => NOW);
    await service.handle(event);

    assert.equal(deps.messageBroker.publishedCommands[0]!.channel, "push");
    // The auto-picked channel, not the (null) requested one, must be
    // what the "accepted" event carries — this is the only place it's
    // recorded for services/projection-notification.
    const status = deps.messageBroker.deliveryStatusEvents[0]!;
    assert.equal(status.status === "accepted" && status.channel, "push");
  });
});
