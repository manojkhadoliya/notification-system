import type {
  ChannelCommand,
  DispatchService,
  MessageBroker,
  NotificationRepository,
} from "@notification-system/domain-notification";
import { DeliveryAttempt } from "@notification-system/domain-notification";
import type { ConsumedMessage } from "@notification-system/infra-kafka";
import { allRetryTopics, commandTopic } from "@notification-system/infra-kafka";
import type { Channel } from "@notification-system/shared-kernel";

const CHANNEL: Channel = "push";
const MAIN_TOPIC = commandTopic(CHANNEL);
const RETRY_TOPICS = new Set(allRetryTopics(CHANNEL));

// A rate-limited attempt isn't a provider failure — `DispatchService`
// deliberately doesn't consume a `RetryPolicy` tier for it (see that
// class's doc comment on the "rate-limited" outcome). Re-queuing at the
// same attemptNumber via the shortest existing retry topic is simpler
// than inventing a new topic for "briefly delayed, not a failure" — see
// this package's README.
const RATE_LIMIT_REQUEUE_DELAY_MS = 30_000;

export interface WorkerServiceDeps {
  readonly dispatchService: DispatchService;
  readonly notificationRepository: NotificationRepository;
  readonly messageBroker: MessageBroker;
}

/**
 * Turns one consumed Kafka message into dispatch + persistence work.
 * `DispatchService` (domain-notification) already does dedupe claim ->
 * rate limit -> send -> DLQ/retry-scheduling; this class is what's left
 * for a composition root: telling a main-topic message from a
 * retry-tier one, holding the latter until its backoff elapses per
 * messaging.md#retry-ladder, and persisting a `DeliveryAttempt` row for
 * whichever outcomes actually conclude an attempt.
 *
 * Structurally identical to `services/worker-sms`'s `WorkerService` —
 * only `CHANNEL` differs.
 *
 * `now`/`sleep` are constructor seams so the retry-tier hold is
 * deterministic and instant in tests — see `worker-service.test.ts`.
 */
export class WorkerService {
  constructor(
    private readonly deps: WorkerServiceDeps,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async handle(message: ConsumedMessage): Promise<void> {
    if (message.value === null) {
      return;
    }
    let command: ChannelCommand;
    try {
      command = JSON.parse(message.value) as ChannelCommand;
    } catch (err) {
      // A malformed message is a producer bug, not something retrying
      // this same bytes will ever fix — log and move on rather than
      // crashing the whole consumer loop over one message.
      console.error(
        `services/worker-push: failed to parse a message on ${message.topic}, skipping`,
        err,
      );
      return;
    }

    if (message.topic === MAIN_TOPIC) {
      await this.dispatch(command);
      return;
    }
    if (RETRY_TOPICS.has(message.topic)) {
      await this.holdForRetry(message, command);
      return;
    }
    console.error(
      `services/worker-push: consumed an unexpected topic "${message.topic}", skipping`,
    );
  }

  private async holdForRetry(
    message: ConsumedMessage,
    command: ChannelCommand,
  ): Promise<void> {
    const retryAfter = Number(message.headers["x-retry-after"]);
    const waitMs = Number.isFinite(retryAfter)
      ? retryAfter - this.now().getTime()
      : 0;
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
    // "held... until its tier's backoff has elapsed, then re-produced to
    // command.{channel} for another attempt" — messaging.md#retry-ladder.
    // Re-publishing (rather than calling dispatch directly from here)
    // keeps every attempt going through the exact same main-topic path,
    // including its ordering/partitioning by recipientId.
    await this.deps.messageBroker.publishCommand(command);
  }

  private async dispatch(command: ChannelCommand): Promise<void> {
    const outcome = await this.deps.dispatchService.dispatch(command);
    switch (outcome.kind) {
      case "sent":
        await this.recordAttempt(
          command,
          "sent",
          outcome.providerMessageId ?? null,
        );
        return;
      case "dead-lettered":
        await this.recordAttempt(command, "failed", outcome.reason);
        return;
      case "retry-scheduled":
      case "already-claimed":
        // Nothing concluded yet — a "retry-scheduled" attempt gets its
        // own DeliveryAttempt row when *it* eventually sends or
        // dead-letters; "already-claimed" means a redelivery of a
        // message some other instance already fully handled.
        return;
      case "rate-limited":
        await this.deps.messageBroker.scheduleRetry(
          command,
          RATE_LIMIT_REQUEUE_DELAY_MS,
        );
        return;
    }
  }

  private async recordAttempt(
    command: ChannelCommand,
    status: "sent" | "failed",
    providerResponse: string | null,
  ): Promise<void> {
    const attempt = DeliveryAttempt.record({
      notificationRequestId: command.notificationRequestId,
      attemptNumber: command.attemptNumber,
      status,
      providerResponse,
    });
    await this.deps.notificationRepository.saveAttempt(attempt);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
