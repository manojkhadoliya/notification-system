import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DispatchService } from "@notification-system/domain-notification";
import type { ChannelCommand } from "@notification-system/domain-notification";
import type { ConsumedMessage } from "@notification-system/infra-kafka";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import { FeedWritingInAppGateway } from "./feed-writing-gateway.js";
import { WorkerService } from "./worker-service.js";
import {
  FakeDedupeRepository,
  FakeMessageBroker,
  FakeNotificationFeedRepository,
  FakeNotificationRepository,
  FakePubsubGateway,
  FakeRateLimiter,
} from "./test-support.js";

function makeCommand(overrides: Partial<ChannelCommand> = {}): ChannelCommand {
  return {
    notificationRequestId: NotificationRequestId(randomUUID()),
    tenantId: TenantId(randomUUID()),
    recipientId: RecipientId(randomUUID()),
    channel: "in_app",
    priority: "standard",
    renderedPayload: { body: "hello" },
    attemptNumber: 1,
    ...overrides,
  };
}

function mainTopicMessage(command: ChannelCommand): ConsumedMessage {
  return {
    topic: "command.in_app",
    key: command.recipientId,
    value: JSON.stringify(command),
    headers: {},
  };
}

function retryTopicMessage(
  topic: string,
  command: ChannelCommand,
  retryAfter: number,
): ConsumedMessage {
  return {
    topic,
    key: command.recipientId,
    value: JSON.stringify(command),
    headers: { "x-retry-after": String(retryAfter) },
  };
}

function makeDeps() {
  const feedRepository = new FakeNotificationFeedRepository();
  const pubsubGateway = new FakePubsubGateway();
  const gateway = new FeedWritingInAppGateway(feedRepository, pubsubGateway);
  const dedupeRepository = new FakeDedupeRepository();
  const rateLimiter = new FakeRateLimiter();
  const messageBroker = new FakeMessageBroker();
  const notificationRepository = new FakeNotificationRepository();
  const dispatchService = new DispatchService({
    gateway,
    dedupeRepository,
    rateLimiter,
    messageBroker,
  });
  return {
    feedRepository,
    pubsubGateway,
    dedupeRepository,
    rateLimiter,
    messageBroker,
    notificationRepository,
    dispatchService,
  };
}

describe("WorkerService.handle — main topic", () => {
  it("writes the feed row, publishes to pub/sub, and records a 'sent' DeliveryAttempt", async () => {
    const deps = makeDeps();
    const command = makeCommand();
    const service = new WorkerService(deps);

    await service.handle(mainTopicMessage(command));

    assert.equal(deps.feedRepository.saveCalls.length, 1);
    assert.equal(deps.pubsubGateway.sentCommands.length, 1);
    assert.equal(deps.notificationRepository.savedAttempts.length, 1);
    const attempt = deps.notificationRepository.savedAttempts[0]!;
    assert.equal(attempt.status, "sent");
    assert.equal(attempt.attemptNumber, 1);
    assert.equal(deps.messageBroker.scheduledRetries.length, 0);
  });

  it("records a 'failed' DeliveryAttempt and DLQs on a malformed payload (non-retryable)", async () => {
    const deps = makeDeps();
    const command = makeCommand({ renderedPayload: {} });
    const service = new WorkerService(deps);

    await service.handle(mainTopicMessage(command));

    assert.equal(deps.messageBroker.dlqMessages.length, 1);
    assert.equal(deps.notificationRepository.savedAttempts.length, 1);
    assert.equal(
      deps.notificationRepository.savedAttempts[0]!.status,
      "failed",
    );
  });

  it("schedules a DispatchService retry when the feed write fails, without the worker separately re-queuing", async () => {
    const deps = makeDeps();
    deps.feedRepository.save = async () => {
      throw new Error("connection reset");
    };
    const command = makeCommand();
    const service = new WorkerService(deps);

    await service.handle(mainTopicMessage(command));

    assert.equal(deps.messageBroker.scheduledRetries.length, 1);
    assert.equal(deps.messageBroker.scheduledRetries[0]!.delayMs, 30_000);
    assert.equal(
      deps.notificationRepository.savedAttempts.length,
      0,
      "an attempt that will retry hasn't concluded yet",
    );
  });

  it("re-queues at the shortest retry tier, without persisting an attempt, when rate-limited", async () => {
    const deps = makeDeps();
    deps.rateLimiter.allow = false;
    const command = makeCommand();
    const service = new WorkerService(deps);

    await service.handle(mainTopicMessage(command));

    assert.equal(
      deps.feedRepository.saveCalls.length,
      0,
      "a rate-limited command never reaches the gateway",
    );
    assert.equal(deps.messageBroker.scheduledRetries.length, 1);
    assert.equal(deps.messageBroker.scheduledRetries[0]!.delayMs, 30_000);
    assert.equal(
      deps.messageBroker.scheduledRetries[0]!.command.attemptNumber,
      1,
      "attemptNumber is unchanged by a rate-limit requeue",
    );
  });

  it("does nothing further when the dedupe claim was already taken", async () => {
    const deps = makeDeps();
    const command = makeCommand();
    await deps.dedupeRepository.tryClaim({
      tenantId: command.tenantId,
      notificationRequestId: command.notificationRequestId,
      recipientId: command.recipientId,
      channel: command.channel,
      claimedAt: new Date(),
    });
    const service = new WorkerService(deps);

    await service.handle(mainTopicMessage(command));

    assert.equal(deps.feedRepository.saveCalls.length, 0);
    assert.equal(deps.notificationRepository.savedAttempts.length, 0);
  });

  it("does not throw on malformed JSON", async () => {
    const deps = makeDeps();
    const service = new WorkerService(deps);
    await service.handle({
      topic: "command.in_app",
      key: "k",
      value: "{not json",
      headers: {},
    });
    assert.equal(deps.feedRepository.saveCalls.length, 0);
  });
});

describe("WorkerService.handle — retry topics", () => {
  it("re-publishes onto the main topic immediately once x-retry-after has already elapsed", async () => {
    const deps = makeDeps();
    const command = makeCommand({ attemptNumber: 2 });
    const now = new Date("2026-01-01T00:01:00.000Z");
    const sleeps: number[] = [];
    const service = new WorkerService(
      deps,
      () => now,
      async (ms) => {
        sleeps.push(ms);
      },
    );

    const retryAfter = now.getTime() - 5_000; // already in the past
    await service.handle(
      retryTopicMessage("command.in_app.retry-30s", command, retryAfter),
    );

    assert.equal(sleeps.length, 0, "an already-elapsed retry must not sleep");
    assert.equal(deps.messageBroker.publishedCommands.length, 1);
    assert.deepEqual(deps.messageBroker.publishedCommands[0], command);
  });

  it("holds until x-retry-after elapses, then re-publishes onto the main topic", async () => {
    const deps = makeDeps();
    const command = makeCommand({ attemptNumber: 2 });
    const now = new Date("2026-01-01T00:00:00.000Z");
    const sleeps: number[] = [];
    const service = new WorkerService(
      deps,
      () => now,
      async (ms) => {
        sleeps.push(ms);
      },
    );

    const retryAfter = now.getTime() + 30_000;
    await service.handle(
      retryTopicMessage("command.in_app.retry-30s", command, retryAfter),
    );

    assert.deepEqual(sleeps, [30_000]);
    assert.equal(deps.messageBroker.publishedCommands.length, 1);
  });

  it("logs and skips an unexpected topic without throwing", async () => {
    const deps = makeDeps();
    const command = makeCommand();
    const service = new WorkerService(deps);

    const message: ConsumedMessage = {
      topic: "command.sms",
      key: command.recipientId,
      value: JSON.stringify(command),
      headers: {},
    };
    await service.handle(message);

    assert.equal(deps.feedRepository.saveCalls.length, 0);
    assert.equal(deps.messageBroker.publishedCommands.length, 0);
  });
});
