// In-memory fakes for every port `services/worker-sms` depends on
// (through `DispatchService` and directly). Used by
// `worker-service.test.ts` — same "test against fakes behind the real
// port" approach used throughout this repo (`DispatchService`'s own
// suite, `services/api`'s route tests, `services/router`'s tests). Not a
// `*.test.ts` file itself, so it compiles to plain `dist/test-support.js`.
import type {
  ChannelCommand,
  DedupeClaim,
  DedupeRepository,
  DeliveryAttempt,
  DeliveryStatusEvent,
  MessageBroker,
  NotificationEvent,
  NotificationRepository,
  NotificationRequest,
  RateLimiter,
} from "@notification-system/domain-notification";
import { dedupeClaimKey } from "@notification-system/domain-notification";
import type {
  GatewaySendResult,
  SmsGateway,
} from "@notification-system/domain-notification";

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

export class FakeSmsGateway implements SmsGateway {
  /** Queue of results to return, one per call, in order — defaults to
   * an infinite stream of `{ success: true }` once exhausted. */
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
    return null; // not exercised by services/worker-sms
  }

  async save(): Promise<void> {
    // not exercised by services/worker-sms
  }

  async findAttempts(): Promise<DeliveryAttempt[]> {
    return []; // not exercised by services/worker-sms
  }

  async saveAttempt(attempt: DeliveryAttempt): Promise<void> {
    this.savedAttempts.push(attempt);
  }
}
