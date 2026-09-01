import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ScheduledNotification } from "@notification-system/domain-notification";
import {
  BroadcastId,
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import { SchedulerService } from "./scheduler-service.js";
import {
  FakeMessageBroker,
  FakeScheduledNotificationRepository,
} from "./test-support.js";

const NOW = new Date("2026-01-01T12:00:00Z");
const tenantId = TenantId(randomUUID());
const recipientId = RecipientId(randomUUID());

function makeScheduled(
  overrides: Partial<{
    dueAt: Date;
    notificationRequestId: string;
    broadcastId: string | null;
  }> = {},
): ScheduledNotification {
  return ScheduledNotification.schedule({
    id: randomUUID(),
    notificationRequestId: NotificationRequestId(
      overrides.notificationRequestId ?? randomUUID(),
    ),
    tenantId,
    recipientId,
    notificationType: "digest",
    payload: { message: "hello" },
    priority: "standard",
    broadcastId:
      overrides.broadcastId === undefined
        ? null
        : overrides.broadcastId === null
          ? null
          : BroadcastId(overrides.broadcastId),
    dueAt: overrides.dueAt ?? new Date(NOW.getTime() - 1000),
  });
}

function makeService(
  repository: FakeScheduledNotificationRepository,
  broker: FakeMessageBroker,
  options: Partial<{
    bucket: number;
    bucketCount: number;
    claimLimit: number;
  }> = {},
): SchedulerService {
  return new SchedulerService(
    { scheduledNotificationRepository: repository, messageBroker: broker },
    {
      bucket: options.bucket ?? 0,
      bucketCount: options.bucketCount ?? 1,
      claimLimit: options.claimLimit ?? 100,
    },
    () => NOW,
  );
}

describe("SchedulerService.pollOnce", () => {
  it("re-emits a due row and marks it emitted", async () => {
    const repository = new FakeScheduledNotificationRepository();
    const broker = new FakeMessageBroker();
    const scheduled = makeScheduled();
    repository.seed(scheduled);

    const count = await makeService(repository, broker).pollOnce();

    assert.equal(count, 1);
    assert.equal(broker.publishedEvents.length, 1);
    assert.equal(repository.savedHistory.length, 1);
    assert.equal(repository.savedHistory[0]!.status, "emitted");
  });

  it("re-emits under the original notificationRequestId, not the row's own id", async () => {
    const repository = new FakeScheduledNotificationRepository();
    const broker = new FakeMessageBroker();
    const requestId = randomUUID();
    const scheduled = makeScheduled({ notificationRequestId: requestId });
    repository.seed(scheduled);
    assert.notEqual(scheduled.id, requestId); // sanity: distinct ids by construction

    await makeService(repository, broker).pollOnce();

    assert.equal(broker.publishedEvents[0]!.notificationRequestId, requestId);
  });

  it("carries broadcastId through to the re-emitted event when present", async () => {
    const repository = new FakeScheduledNotificationRepository();
    const broker = new FakeMessageBroker();
    const broadcastId = randomUUID();
    repository.seed(makeScheduled({ broadcastId }));

    await makeService(repository, broker).pollOnce();

    assert.equal(broker.publishedEvents[0]!.broadcastId, broadcastId);
  });

  it("does not claim a row that isn't due yet", async () => {
    const repository = new FakeScheduledNotificationRepository();
    const broker = new FakeMessageBroker();
    repository.seed(makeScheduled({ dueAt: new Date(NOW.getTime() + 60_000) }));

    const count = await makeService(repository, broker).pollOnce();

    assert.equal(count, 0);
    assert.equal(broker.publishedEvents.length, 0);
  });

  it("does not claim a row outside this shard's bucket", async () => {
    const repository = new FakeScheduledNotificationRepository();
    const broker = new FakeMessageBroker();
    // dueMinute is derived from dueAt; pick a dueAt whose minute is even,
    // then ask for bucket 1 of 2 (odd minutes only) — this row belongs to
    // the other shard.
    const dueAt = new Date("2026-01-01T11:58:00Z"); // minutesSinceEpoch is even
    repository.seed(makeScheduled({ dueAt }));

    const count = await makeService(repository, broker, {
      bucket: 1,
      bucketCount: 2,
    }).pollOnce();

    assert.equal(count, 0);
  });

  it("returns 0 when nothing is due", async () => {
    const repository = new FakeScheduledNotificationRepository();
    const broker = new FakeMessageBroker();

    const count = await makeService(repository, broker).pollOnce();

    assert.equal(count, 0);
  });

  it("respects claimLimit, leaving the rest pending for the next poll", async () => {
    const repository = new FakeScheduledNotificationRepository();
    const broker = new FakeMessageBroker();
    repository.seed(makeScheduled());
    repository.seed(makeScheduled());
    repository.seed(makeScheduled());

    const count = await makeService(repository, broker, {
      claimLimit: 2,
    }).pollOnce();

    assert.equal(count, 2);
    assert.equal(broker.publishedEvents.length, 2);
  });

  it("a publish failure for one row doesn't block the rest of the batch, and isn't marked emitted", async () => {
    const repository = new FakeScheduledNotificationRepository();
    const broker = new FakeMessageBroker();
    const badRequestId = randomUUID();
    const bad = makeScheduled({ notificationRequestId: badRequestId });
    const good = makeScheduled();
    repository.seed(bad);
    repository.seed(good);
    broker.failFor.add(badRequestId);

    const count = await makeService(repository, broker).pollOnce();

    assert.equal(count, 1);
    assert.equal(broker.publishedEvents.length, 1);
    assert.equal(
      broker.publishedEvents[0]!.notificationRequestId,
      good.notificationRequestId,
    );
    // The failed row's last saved state (from claimDue's own internal
    // claim, mirrored via savedHistory being empty for it) must not be
    // "emitted" — only the successful row's save() call happened.
    assert.equal(repository.savedHistory.length, 1);
    assert.equal(
      repository.savedHistory[0]!.notificationRequestId,
      good.notificationRequestId,
    );
  });
});
