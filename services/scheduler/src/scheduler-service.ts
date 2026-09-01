import type {
  MessageBroker,
  ScheduledNotification,
  ScheduledNotificationRepository,
} from "@notification-system/domain-notification";

export interface SchedulerServiceDeps {
  readonly scheduledNotificationRepository: ScheduledNotificationRepository;
  readonly messageBroker: MessageBroker;
}

export interface SchedulerServiceOptions {
  readonly bucket: number;
  readonly bucketCount: number;
  readonly claimLimit: number;
}

/**
 * One poller shard's core loop — see ADR 0011. `services/router` writes
 * a `ScheduledNotification` row (with jitter, so a shared quiet-hours
 * end minute doesn't collide) when it defers instead of dropping or
 * proceeding; this class claims rows past due, in this shard's
 * `(dueMinute, bucket)` slice, and re-emits each onto the event backbone
 * exactly as if it had just arrived — no special-cased "this came from
 * the scheduler" path anywhere downstream.
 *
 * `now` is a constructor seam (defaults to `() => new Date()`) so
 * `isDue` behavior is deterministic in tests — same pattern as
 * `RouterService`/`WorkerService` elsewhere in this codebase. The actual
 * poll *loop* (repeatedly calling `pollOnce()` on an interval) is
 * `index.ts`'s job, not this class's — this class is one cycle,
 * unit-tested directly; the loop wrapper is exercised by
 * `scripts/smoke-test.mjs` and a real run, not the automated suite (same
 * split every other `services/*` composition root in this repo uses).
 */
export class SchedulerService {
  constructor(
    private readonly deps: SchedulerServiceDeps,
    private readonly options: SchedulerServiceOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Claims up to `claimLimit` due rows in this shard's bucket and
   * re-emits each. Returns how many it processed (0 is the normal case
   * — most polls find nothing due).
   *
   * **Known limitation, not silently glossed over:** if `publishEvent`
   * or the follow-up `save(markEmitted())` throws for a claimed row
   * (logged, not re-thrown — one poison-pill row must not block the
   * rest of the batch), that row is left in `"claimed"` status forever.
   * `claimDue` only ever selects `status = 'pending'` rows, so there is
   * no automatic reclaim of a stuck "claimed but never emitted" row —
   * unlike a `DedupeClaim`, where "already claimed" is *always* the
   * correct terminal outcome, a scheduler claim that never got emitted
   * is a real gap with no automated recovery path yet. See this
   * package's README.
   */
  async pollOnce(): Promise<number> {
    const claimed = await this.deps.scheduledNotificationRepository.claimDue({
      upTo: this.now(),
      dueMinuteBucket: this.options.bucket,
      bucketCount: this.options.bucketCount,
      limit: this.options.claimLimit,
    });

    let emitted = 0;
    for (const notification of claimed) {
      const ok = await this.emitOne(notification);
      if (ok) emitted += 1;
    }
    return emitted;
  }

  private async emitOne(notification: ScheduledNotification): Promise<boolean> {
    try {
      await this.deps.messageBroker.publishEvent({
        notificationRequestId: notification.notificationRequestId,
        tenantId: notification.tenantId,
        recipientId: notification.recipientId,
        notificationType: notification.notificationType,
        channel: notification.channel,
        templateVersionId: notification.templateVersionId,
        payloadRef: notification.payload,
        priority: notification.priority,
        broadcastId: notification.broadcastId,
        idempotencyKey: notification.idempotencyKey,
      });
      await this.deps.scheduledNotificationRepository.save(
        notification.markEmitted(),
      );
      return true;
    } catch (err) {
      console.error(
        `services/scheduler: failed to emit ScheduledNotification ${notification.id} ` +
          `(notificationRequestId ${notification.notificationRequestId}) — ` +
          "it stays claimed and will not be retried automatically:",
        err,
      );
      return false;
    }
  }
}
