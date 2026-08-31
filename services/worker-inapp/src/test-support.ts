// In-memory fakes for every port `services/worker-inapp` depends on
// (through `DispatchService`/`FeedWritingInAppGateway` and directly).
// Used by `worker-service.test.ts` and `feed-writing-gateway.test.ts` —
// same "test against fakes behind the real port" approach used
// throughout this repo. Not a `*.test.ts` file itself, so it compiles to
// plain `dist/test-support.js`.
import type {
  ChannelCommand,
  DedupeClaim,
  DedupeRepository,
  DeliveryAttempt,
  DeliveryStatusEvent,
  GatewaySendResult,
  InAppGateway,
  MessageBroker,
  NotificationEvent,
  NotificationFeedItem,
  NotificationFeedRepository,
  NotificationRepository,
  NotificationRequest,
  RateLimiter,
} from "@notification-system/domain-notification";
import { dedupeClaimKey } from "@notification-system/domain-notification";
import type {
  NotificationRequestId,
  RecipientId,
} from "@notification-system/shared-kernel";

export class FakeDedupeRepository implements DedupeRepository {
  private readonly claimed = new Set<string>();

  async tryClaim(claim: DedupeClaim): Promise<boolean> {
    const key = dedupeClaimKey(claim);
    if (this.claimed.has(key)) {
      return false;
    }
    this.claimed.add(key);
    return true;
  }
}

export class FakeRateLimiter implements RateLimiter {
  allow = true;

  async tryConsume(): Promise<boolean> {
    return this.allow;
  }
}

export class FakeNotificationFeedRepository implements NotificationFeedRepository {
  private readonly byNotificationRequestId = new Map<
    string,
    NotificationFeedItem
  >();
  /** Every `save()` call, in order — including ones that overwrite an
   * earlier one, so a test can assert on redelivery behavior. */
  readonly saveCalls: NotificationFeedItem[] = [];

  async save(item: NotificationFeedItem): Promise<void> {
    this.saveCalls.push(item);
    this.byNotificationRequestId.set(item.notificationRequestId, item);
  }

  async findByRecipient(
    recipientId: RecipientId,
    options?: { unreadOnly?: boolean },
  ): Promise<NotificationFeedItem[]> {
    return [...this.byNotificationRequestId.values()]
      .filter((item) => item.recipientId === recipientId)
      .filter((item) => !options?.unreadOnly || item.readAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async markRead(
    recipientId: RecipientId,
    notificationRequestId: NotificationRequestId,
  ): Promise<void> {
    const item = this.byNotificationRequestId.get(notificationRequestId);
    if (item === undefined || item.recipientId !== recipientId) {
      return;
    }
    this.byNotificationRequestId.set(notificationRequestId, item.markRead());
  }
}

export class FakePubsubGateway implements InAppGateway {
  results: GatewaySendResult[] = [];
  readonly sentCommands: ChannelCommand[] = [];

  async send(command: ChannelCommand): Promise<GatewaySendResult> {
    this.sentCommands.push(command);
    return this.results.shift() ?? { success: true };
  }
}

export class FakeMessageBroker implements MessageBroker {
  readonly publishedEvents: NotificationEvent[] = [];
  readonly publishedCommands: ChannelCommand[] = [];
  readonly scheduledRetries: { command: ChannelCommand; delayMs: number }[] =
    [];
  readonly dlqMessages: { command: ChannelCommand; reason: string }[] = [];
  readonly deliveryStatusEvents: DeliveryStatusEvent[] = [];

  async publishEvent(event: NotificationEvent): Promise<void> {
    this.publishedEvents.push(event);
  }

  async publishCommand(command: ChannelCommand): Promise<void> {
    this.publishedCommands.push(command);
  }

  async scheduleRetry(command: ChannelCommand, delayMs: number): Promise<void> {
    this.scheduledRetries.push({ command, delayMs });
  }

  async publishToDlq(command: ChannelCommand, reason: string): Promise<void> {
    this.dlqMessages.push({ command, reason });
  }

  async publishDeliveryStatus(event: DeliveryStatusEvent): Promise<void> {
    this.deliveryStatusEvents.push(event);
  }
}

export class FakeNotificationRepository implements NotificationRepository {
  readonly savedAttempts: DeliveryAttempt[] = [];

  async findById(): Promise<NotificationRequest | null> {
    return null; // not exercised by services/worker-inapp
  }

  async save(): Promise<void> {
    // not exercised by services/worker-inapp
  }

  async findAttempts(): Promise<DeliveryAttempt[]> {
    return []; // not exercised by services/worker-inapp
  }

  async saveAttempt(attempt: DeliveryAttempt): Promise<void> {
    this.savedAttempts.push(attempt);
  }
}
