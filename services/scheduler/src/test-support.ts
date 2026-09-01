import type {
  MessageBroker,
  NotificationEvent,
  ScheduledNotification,
  ScheduledNotificationRepository,
} from "@notification-system/domain-notification";

/** In-memory fake — a real `claimDue`, unlike `services/router`'s own
 * `FakeScheduledNotificationRepository` (which stubs `claimDue` to `[]`
 * since routing never calls it): mirrors `PostgresScheduledNotificationRepository`'s
 * contract closely enough to exercise `SchedulerService`'s claim/emit
 * logic without a live Postgres — status filtering, the `(dueMinute,
 * bucket)` shard predicate, and the claim `limit`. */
export class FakeScheduledNotificationRepository implements ScheduledNotificationRepository {
  private readonly rows = new Map<string, ScheduledNotification>();
  readonly savedHistory: ScheduledNotification[] = [];

  seed(notification: ScheduledNotification): void {
    this.rows.set(notification.id, notification);
  }

  async save(notification: ScheduledNotification): Promise<void> {
    this.rows.set(notification.id, notification);
    this.savedHistory.push(notification);
  }

  async claimDue(params: {
    upTo: Date;
    dueMinuteBucket: number;
    bucketCount: number;
    limit: number;
  }): Promise<ScheduledNotification[]> {
    const claimed: ScheduledNotification[] = [];
    for (const notification of this.rows.values()) {
      if (claimed.length >= params.limit) break;
      if (notification.status !== "pending") continue;
      if (notification.dueAt > params.upTo) continue;
      if (
        notification.dueMinute % params.bucketCount !==
        params.dueMinuteBucket
      ) {
        continue;
      }
      const claim = notification.claim(params.upTo);
      this.rows.set(claim.id, claim);
      claimed.push(claim);
    }
    return claimed;
  }
}

export class FakeMessageBroker implements MessageBroker {
  readonly publishedEvents: NotificationEvent[] = [];
  /** Set a `notificationRequestId` here to make `publishEvent` throw for
   * that one event — exercises `SchedulerService.pollOnce`'s per-row
   * error handling without needing a real broker failure. */
  readonly failFor = new Set<string>();

  async publishEvent(event: NotificationEvent): Promise<void> {
    if (this.failFor.has(event.notificationRequestId)) {
      throw new Error(
        `simulated publish failure for ${event.notificationRequestId}`,
      );
    }
    this.publishedEvents.push(event);
  }

  async publishCommand(): Promise<void> {
    // Not exercised by services/scheduler — that's services/router's job.
  }

  async scheduleRetry(): Promise<void> {
    // Not exercised by services/scheduler — that's the channel workers' job.
  }

  async publishToDlq(): Promise<void> {
    // Not exercised by services/scheduler — see scheduleRetry's comment above.
  }

  async publishDeliveryStatus(): Promise<void> {
    // Not exercised by services/scheduler — that's services/router's job.
  }
}
