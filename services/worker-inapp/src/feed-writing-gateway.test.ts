import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ChannelCommand } from "@notification-system/domain-notification";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import { FeedWritingInAppGateway } from "./feed-writing-gateway.js";
import {
  FakeNotificationFeedRepository,
  FakePubsubGateway,
} from "./test-support.js";

function makeCommand(overrides: Partial<ChannelCommand> = {}): ChannelCommand {
  return {
    notificationRequestId: NotificationRequestId(randomUUID()),
    tenantId: TenantId(randomUUID()),
    recipientId: RecipientId(randomUUID()),
    channel: "in_app",
    priority: "standard",
    renderedPayload: { body: "your order shipped" },
    attemptNumber: 1,
    ...overrides,
  };
}

describe("FeedWritingInAppGateway", () => {
  it("writes the feed row, then publishes to pub/sub", async () => {
    const feedRepository = new FakeNotificationFeedRepository();
    const pubsubGateway = new FakePubsubGateway();
    const gateway = new FeedWritingInAppGateway(feedRepository, pubsubGateway);
    const command = makeCommand();

    const result = await gateway.send(command);

    assert.equal(result.success, true);
    assert.equal(feedRepository.saveCalls.length, 1);
    assert.equal(feedRepository.saveCalls[0]!.summary, "your order shipped");
    assert.equal(
      feedRepository.saveCalls[0]!.notificationRequestId,
      command.notificationRequestId,
    );
    assert.equal(
      pubsubGateway.sentCommands.length,
      1,
      "pub/sub is only reached after the feed row is written",
    );
  });

  it("rejects a malformed renderedPayload as not retryable, without touching either dependency", async () => {
    const feedRepository = new FakeNotificationFeedRepository();
    const pubsubGateway = new FakePubsubGateway();
    const gateway = new FeedWritingInAppGateway(feedRepository, pubsubGateway);

    const result = await gateway.send(makeCommand({ renderedPayload: {} }));

    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, false);
    assert.equal(feedRepository.saveCalls.length, 0);
    assert.equal(pubsubGateway.sentCommands.length, 0);
  });

  it("reports a feed-write failure as retryable, without reaching pub/sub", async () => {
    const feedRepository = new FakeNotificationFeedRepository();
    feedRepository.save = async () => {
      throw new Error("connection reset");
    };
    const pubsubGateway = new FakePubsubGateway();
    const gateway = new FeedWritingInAppGateway(feedRepository, pubsubGateway);

    const result = await gateway.send(makeCommand());

    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, true);
    assert.equal(pubsubGateway.sentCommands.length, 0);
  });

  it("succeeds even when the pub/sub publish finds no live subscriber (still returns whatever the pub/sub gateway returns)", async () => {
    const feedRepository = new FakeNotificationFeedRepository();
    const pubsubGateway = new FakePubsubGateway();
    pubsubGateway.results = [{ success: true }]; // a publish with zero subscribers still succeeds — see RedisInAppGateway's doc comment
    const gateway = new FeedWritingInAppGateway(feedRepository, pubsubGateway);

    const result = await gateway.send(makeCommand());

    assert.equal(result.success, true);
    assert.equal(
      feedRepository.saveCalls.length,
      1,
      "the feed row is written regardless of whether anyone is listening",
    );
  });

  it("re-writing for the same notificationRequestId on a redelivery upserts, not duplicates", async () => {
    const feedRepository = new FakeNotificationFeedRepository();
    const pubsubGateway = new FakePubsubGateway();
    const gateway = new FeedWritingInAppGateway(feedRepository, pubsubGateway);
    const command = makeCommand({ attemptNumber: 2 }); // a retry redelivery

    await gateway.send(command);
    await gateway.send(command);

    assert.equal(
      feedRepository.saveCalls.length,
      2,
      "save() is called each time",
    );
    const items = await feedRepository.findByRecipient(command.recipientId);
    assert.equal(
      items.length,
      1,
      "but only one logical row exists, per the fake's upsert-by-notificationRequestId semantics",
    );
  });
});
