import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ConsumedMessage } from "@notification-system/infra-kafka";
import {
  EVENTS_BROADCAST_CHUNKS_TOPIC,
  EVENTS_BROADCAST_TOPIC,
} from "@notification-system/infra-kafka";
import { MAX_RECIPIENTS_PER_CHUNK } from "@notification-system/domain-notification";
import { RecipientId, TenantId } from "@notification-system/shared-kernel";
import { FanoutExpanderService } from "./fanout-expander-service.js";
import {
  FakeAudienceResolver,
  FakeMessageBroker,
  makeBroadcastRequest,
} from "./test-support.js";

const tenantId = TenantId("tenant-1");

function broadcastMessage(value: unknown): ConsumedMessage {
  return {
    topic: EVENTS_BROADCAST_TOPIC,
    key: null,
    value: JSON.stringify(value),
    headers: {},
  };
}

function chunkMessage(value: unknown): ConsumedMessage {
  return {
    topic: EVENTS_BROADCAST_CHUNKS_TOPIC,
    key: null,
    value: JSON.stringify(value),
    headers: {},
  };
}

function recipients(count: number): RecipientId[] {
  return Array.from({ length: count }, (_, i) => RecipientId(`recipient-${i}`));
}

describe("FanoutExpanderService — stage 1 (events.broadcast)", () => {
  it("resolves the audience and publishes one chunk for a small audience", async () => {
    const audienceResolver = new FakeAudienceResolver();
    audienceResolver.seed(tenantId, recipients(3));
    const messageBroker = new FakeMessageBroker();
    const service = new FanoutExpanderService({
      audienceResolver,
      messageBroker,
    });
    const request = makeBroadcastRequest(tenantId);

    await service.handle(broadcastMessage(request));

    assert.equal(messageBroker.publishedChunks.length, 1);
    const chunk = messageBroker.publishedChunks[0]!;
    assert.equal(chunk.recipientIds.length, 3);
    assert.equal(chunk.broadcastId, request.id);
    assert.equal(chunk.tenantId, request.tenantId);
    assert.equal(chunk.notificationType, request.notificationType);
    assert.deepEqual(chunk.payload, request.payload);
    assert.equal(chunk.priority, request.priority);
  });

  it("splits a large audience into work-sized chunks", async () => {
    const audienceResolver = new FakeAudienceResolver();
    audienceResolver.seed(tenantId, recipients(MAX_RECIPIENTS_PER_CHUNK + 1));
    const messageBroker = new FakeMessageBroker();
    const service = new FanoutExpanderService({
      audienceResolver,
      messageBroker,
    });

    await service.handle(broadcastMessage(makeBroadcastRequest(tenantId)));

    assert.equal(messageBroker.publishedChunks.length, 2);
    assert.equal(
      messageBroker.publishedChunks[0]!.recipientIds.length,
      MAX_RECIPIENTS_PER_CHUNK,
    );
    assert.equal(messageBroker.publishedChunks[1]!.recipientIds.length, 1);
  });

  it("publishes zero chunks, without error, for an audience that resolves to nobody", async () => {
    const audienceResolver = new FakeAudienceResolver();
    const messageBroker = new FakeMessageBroker();
    const service = new FanoutExpanderService({
      audienceResolver,
      messageBroker,
    });

    await service.handle(broadcastMessage(makeBroadcastRequest(tenantId)));

    assert.equal(messageBroker.publishedChunks.length, 0);
  });

  it("logs and skips, without throwing, when the audience can't be resolved", async () => {
    const audienceResolver = new FakeAudienceResolver();
    audienceResolver.failFor.add(tenantId);
    const messageBroker = new FakeMessageBroker();
    const service = new FanoutExpanderService({
      audienceResolver,
      messageBroker,
    });

    await service.handle(broadcastMessage(makeBroadcastRequest(tenantId)));

    assert.equal(messageBroker.publishedChunks.length, 0);
  });

  it("does not throw on malformed JSON", async () => {
    const audienceResolver = new FakeAudienceResolver();
    const messageBroker = new FakeMessageBroker();
    const service = new FanoutExpanderService({
      audienceResolver,
      messageBroker,
    });

    await service.handle({
      topic: EVENTS_BROADCAST_TOPIC,
      key: null,
      value: "{not json",
      headers: {},
    });

    assert.equal(messageBroker.publishedChunks.length, 0);
  });

  it("produces the same chunkId(s) on a redelivery of the same broadcast — redelivery safety", async () => {
    const audienceResolver = new FakeAudienceResolver();
    audienceResolver.seed(tenantId, recipients(3));
    const request = makeBroadcastRequest(tenantId);

    const brokerA = new FakeMessageBroker();
    await new FanoutExpanderService({
      audienceResolver,
      messageBroker: brokerA,
    }).handle(broadcastMessage(request));

    const brokerB = new FakeMessageBroker();
    await new FanoutExpanderService({
      audienceResolver,
      messageBroker: brokerB,
    }).handle(broadcastMessage(request));

    assert.equal(
      brokerA.publishedChunks[0]!.chunkId,
      brokerB.publishedChunks[0]!.chunkId,
    );
  });
});

describe("FanoutExpanderService — stage 2 (events.broadcast.chunks)", () => {
  function makeChunk(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      chunkId: "chunk-1",
      broadcastId: "broadcast-1",
      recipientIds: ["r1", "r2"],
      tenantId,
      notificationType: "digest",
      payload: { message: "hello" },
      priority: "standard",
      ...overrides,
    };
  }

  it("expands every recipient in the chunk into its own NotificationEvent", async () => {
    const audienceResolver = new FakeAudienceResolver();
    const messageBroker = new FakeMessageBroker();
    const service = new FanoutExpanderService({
      audienceResolver,
      messageBroker,
    });

    await service.handle(chunkMessage(makeChunk()));

    assert.equal(messageBroker.publishedEvents.length, 2);
    const [first, second] = messageBroker.publishedEvents;
    assert.equal(first!.recipientId, "r1");
    assert.equal(second!.recipientId, "r2");
    assert.equal(first!.broadcastId, "broadcast-1");
    assert.equal(first!.channel, null);
    assert.equal(first!.templateVersionId, null);
    assert.deepEqual(first!.payloadRef, { message: "hello" });
    assert.notEqual(
      first!.notificationRequestId,
      second!.notificationRequestId,
    );
  });

  it("does not throw on malformed JSON", async () => {
    const audienceResolver = new FakeAudienceResolver();
    const messageBroker = new FakeMessageBroker();
    const service = new FanoutExpanderService({
      audienceResolver,
      messageBroker,
    });

    await service.handle({
      topic: EVENTS_BROADCAST_CHUNKS_TOPIC,
      key: null,
      value: "{not json",
      headers: {},
    });

    assert.equal(messageBroker.publishedEvents.length, 0);
  });

  it("produces the same notificationRequestId on a redelivery of the same chunk — redelivery safety", async () => {
    const audienceResolver = new FakeAudienceResolver();
    const chunk = makeChunk();

    const brokerA = new FakeMessageBroker();
    await new FanoutExpanderService({
      audienceResolver,
      messageBroker: brokerA,
    }).handle(chunkMessage(chunk));

    const brokerB = new FakeMessageBroker();
    await new FanoutExpanderService({
      audienceResolver,
      messageBroker: brokerB,
    }).handle(chunkMessage(chunk));

    assert.equal(
      brokerA.publishedEvents[0]!.notificationRequestId,
      brokerB.publishedEvents[0]!.notificationRequestId,
    );
  });
});

describe("FanoutExpanderService.handle — topic routing", () => {
  it("logs and skips an unexpected topic without throwing", async () => {
    const audienceResolver = new FakeAudienceResolver();
    const messageBroker = new FakeMessageBroker();
    const service = new FanoutExpanderService({
      audienceResolver,
      messageBroker,
    });

    await service.handle({
      topic: "some.other.topic",
      key: null,
      value: "{}",
      headers: {},
    });

    assert.equal(messageBroker.publishedChunks.length, 0);
    assert.equal(messageBroker.publishedEvents.length, 0);
  });
});
