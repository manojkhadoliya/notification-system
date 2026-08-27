import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import type { ChannelCommand } from "./channel-command.js";
import type { DedupeClaim } from "./dedupe-claim.js";
import { dedupeClaimKey } from "./dedupe-claim.js";
import { DispatchService } from "./dispatch-service.js";
import type { GatewaySendResult, SmsGateway } from "./gateways.js";
import type {
  DedupeRepository,
  DeliveryStatusEvent,
  MessageBroker,
  NotificationEvent,
} from "./ports.js";
import type { RateLimiter } from "./rate-limiter.js";

// --- in-memory fakes -------------------------------------------------
// Exactly what domain-notification's README promises: "Testable in
// isolation with in-memory fake adapters."

class FakeDedupeRepository implements DedupeRepository {
  readonly claimed = new Set<string>();
  readonly claimCalls: DedupeClaim[] = [];

  async tryClaim(claim: DedupeClaim): Promise<boolean> {
    this.claimCalls.push(claim);
    const key = dedupeClaimKey(claim);
    if (this.claimed.has(key)) {
      return false;
    }
    this.claimed.add(key);
    return true;
  }
}

class FakeRateLimiter implements RateLimiter {
  allow = true;

  async tryConsume(): Promise<boolean> {
    return this.allow;
  }
}

class FakeMessageBroker implements MessageBroker {
  readonly deliveryStatusEvents: DeliveryStatusEvent[] = [];
  readonly dlqCalls: { command: ChannelCommand; reason: string }[] = [];
  readonly retryCalls: { command: ChannelCommand; delayMs: number }[] = [];

  async publishEvent(_event: NotificationEvent): Promise<void> {}
  async publishCommand(_command: ChannelCommand): Promise<void> {}

  async scheduleRetry(command: ChannelCommand, delayMs: number): Promise<void> {
    this.retryCalls.push({ command, delayMs });
  }

  async publishToDlq(command: ChannelCommand, reason: string): Promise<void> {
    this.dlqCalls.push({ command, reason });
  }

  async publishDeliveryStatus(event: DeliveryStatusEvent): Promise<void> {
    this.deliveryStatusEvents.push(event);
  }
}

class FakeSmsGateway implements SmsGateway {
  result: GatewaySendResult = {
    success: true,
    providerMessageId: "provider-1",
  };
  readonly calls: ChannelCommand[] = [];

  async send(command: ChannelCommand): Promise<GatewaySendResult> {
    this.calls.push(command);
    return this.result;
  }
}

function baseCommand(overrides: Partial<ChannelCommand> = {}): ChannelCommand {
  return {
    notificationRequestId: NotificationRequestId(
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ),
    tenantId: TenantId("cccccccc-cccc-cccc-cccc-cccccccccccc"),
    recipientId: RecipientId("dddddddd-dddd-dddd-dddd-dddddddddddd"),
    channel: "sms",
    priority: "standard",
    renderedPayload: { body: "hello" },
    attemptNumber: 1,
    ...overrides,
  };
}

function setup() {
  const dedupeRepository = new FakeDedupeRepository();
  const rateLimiter = new FakeRateLimiter();
  const messageBroker = new FakeMessageBroker();
  const gateway = new FakeSmsGateway();
  const service = new DispatchService({
    gateway,
    dedupeRepository,
    rateLimiter,
    messageBroker,
  });
  return { dedupeRepository, rateLimiter, messageBroker, gateway, service };
}

test("successful send: claims, calls the gateway, publishes 'sent'", async () => {
  const { service, gateway, messageBroker, dedupeRepository } = setup();
  const outcome = await service.dispatch(baseCommand());

  assert.deepEqual(outcome, { kind: "sent", providerMessageId: "provider-1" });
  assert.equal(gateway.calls.length, 1);
  assert.equal(dedupeRepository.claimCalls.length, 1);
  assert.equal(messageBroker.deliveryStatusEvents.length, 1);
  assert.equal(messageBroker.deliveryStatusEvents[0]?.status, "sent");
});

test("a redelivered attempt-1 message finds the claim already taken and never calls the gateway", async () => {
  const { service, gateway, dedupeRepository } = setup();
  await service.dispatch(baseCommand());
  const outcome = await service.dispatch(baseCommand()); // same key, "redelivered"

  assert.deepEqual(outcome, { kind: "already-claimed" });
  assert.equal(gateway.calls.length, 1, "gateway must not be called twice");
  assert.equal(dedupeRepository.claimCalls.length, 2);
});

test("attempt 2+ does not re-attempt the claim (see class-level doc comment)", async () => {
  const { service, dedupeRepository, gateway } = setup();
  await service.dispatch(baseCommand({ attemptNumber: 2 }));

  assert.equal(
    dedupeRepository.claimCalls.length,
    0,
    "claim must only be attempted on attemptNumber === 1",
  );
  assert.equal(gateway.calls.length, 1, "the gateway is still called");
});

test("rate-limited: gateway is never called, no delivery-status published", async () => {
  const { service, rateLimiter, gateway, messageBroker } = setup();
  rateLimiter.allow = false;

  const outcome = await service.dispatch(baseCommand());

  assert.deepEqual(outcome, { kind: "rate-limited" });
  assert.equal(gateway.calls.length, 0);
  assert.equal(messageBroker.deliveryStatusEvents.length, 0);
});

test("retryable failure schedules a retry at the correct backoff tier", async () => {
  const { service, gateway, messageBroker } = setup();
  gateway.result = { success: false, error: "timeout", retryable: true };

  const outcome = await service.dispatch(baseCommand({ attemptNumber: 1 }));

  assert.deepEqual(outcome, { kind: "retry-scheduled", delayMs: 30_000 });
  assert.equal(messageBroker.retryCalls.length, 1);
  assert.equal(messageBroker.retryCalls[0]?.command.attemptNumber, 2);
});

test("non-retryable failure goes straight to the DLQ", async () => {
  const { service, gateway, messageBroker } = setup();
  gateway.result = {
    success: false,
    error: "invalid phone number",
    retryable: false,
  };

  const outcome = await service.dispatch(baseCommand());

  assert.deepEqual(outcome, {
    kind: "dead-lettered",
    reason: "invalid phone number",
  });
  assert.equal(messageBroker.dlqCalls.length, 1);
  assert.equal(
    messageBroker.deliveryStatusEvents.find((e) => e.status === "failed")
      ?.attemptNumber,
    1,
  );
});

test("a retryable failure on the last tier is dead-lettered instead of retried again", async () => {
  const { service, gateway, messageBroker } = setup();
  gateway.result = { success: false, error: "still failing", retryable: true };

  const outcome = await service.dispatch(baseCommand({ attemptNumber: 4 }));

  assert.deepEqual(outcome, {
    kind: "dead-lettered",
    reason: "still failing",
  });
  assert.equal(messageBroker.retryCalls.length, 0);
  assert.equal(messageBroker.dlqCalls.length, 1);
});
