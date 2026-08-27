import type { ChannelCommand } from "./channel-command.js";
import type { DedupeClaim } from "./dedupe-claim.js";
import type {
  EmailGateway,
  GatewaySendResult,
  InAppGateway,
  PushGateway,
  SmsGateway,
} from "./gateways.js";
import type { DedupeRepository, MessageBroker } from "./ports.js";
import type { RateLimiter } from "./rate-limiter.js";
import { RetryPolicy } from "./retry-policy.js";

export type DispatchOutcome =
  | { readonly kind: "sent"; readonly providerMessageId?: string }
  | { readonly kind: "retry-scheduled"; readonly delayMs: number }
  | { readonly kind: "dead-lettered"; readonly reason: string }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "already-claimed" };

type Gateway = SmsGateway | PushGateway | EmailGateway | InAppGateway;

/**
 * Dedupe claim -> rate limit -> send -> persist, consumed by every channel
 * worker — see domain-model.md#notification-delivery-core-domain. One
 * instance per worker process, constructed with that worker's own
 * gateway (see `services/worker-sms` etc.'s README "Depends on" lists).
 *
 * **Dedupe-claim scope, and why it's only attempted on the first
 * attempt:** `DedupeClaim`'s unique key is `(tenantId,
 * notificationRequestId, recipientId, channel)` — no `attemptNumber` (see
 * data-model.md#dedupeclaim and ADR 0010). A pure "claim before every
 * attempt" reading would mean a legitimate retry (attempt 2+, after a
 * transient provider failure on attempt 1) finds the key already claimed
 * and incorrectly treats that as "already sent." This implementation
 * claims once, on `attemptNumber === 1`; attempts after that are
 * understood to already own the send (the same logical retry chain that
 * took the claim) and go straight to the gateway call. This still closes
 * the gap ADR 0010 names (a Kafka redelivery of the *same* attempt-1
 * message finds the claim taken and skips the gateway call) — it just
 * doesn't additionally block a *different*, later attempt number from
 * proceeding. **Flagged as worth an explicit ADR note**, not silently
 * decided: the alternative (a claim that tracks in-flight/succeeded
 * status rather than a one-shot insert) is a real design choice with its
 * own trade-offs and should be reviewed, not just inherited from this
 * comment.
 */
export class DispatchService {
  private readonly retryPolicy: RetryPolicy;

  constructor(
    private readonly deps: {
      readonly gateway: Gateway;
      readonly dedupeRepository: DedupeRepository;
      readonly rateLimiter: RateLimiter;
      readonly messageBroker: MessageBroker;
      readonly retryPolicy?: RetryPolicy;
    },
  ) {
    this.retryPolicy = deps.retryPolicy ?? new RetryPolicy();
  }

  async dispatch(command: ChannelCommand): Promise<DispatchOutcome> {
    if (command.attemptNumber === 1) {
      const claim: DedupeClaim = {
        tenantId: command.tenantId,
        notificationRequestId: command.notificationRequestId,
        recipientId: command.recipientId,
        channel: command.channel,
        claimedAt: new Date(),
      };
      const claimed = await this.deps.dedupeRepository.tryClaim(claim);
      if (!claimed) {
        return { kind: "already-claimed" };
      }
    }

    const withinBudget = await this.deps.rateLimiter.tryConsume(
      command.tenantId,
      command.channel,
    );
    if (!withinBudget) {
      // The caller (the worker's consume loop) decides how to re-queue a
      // rate-limited command — see multi-tenancy.md#rate-limiting
      // ("exceeding it at dispatch time re-queues the message with
      // backoff rather than dropping it"). This isn't the same path as a
      // provider failure, so it doesn't consume a `RetryPolicy` attempt.
      return { kind: "rate-limited" };
    }

    const result: GatewaySendResult = await this.deps.gateway.send(command);

    if (result.success) {
      await this.deps.messageBroker.publishDeliveryStatus({
        notificationRequestId: command.notificationRequestId,
        status: "sent",
        attemptNumber: command.attemptNumber,
        occurredAt: new Date(),
      });
      return result.providerMessageId === undefined
        ? { kind: "sent" }
        : { kind: "sent", providerMessageId: result.providerMessageId };
    }

    if (!result.retryable) {
      await this.deps.messageBroker.publishToDlq(command, result.error);
      await this.deps.messageBroker.publishDeliveryStatus({
        notificationRequestId: command.notificationRequestId,
        status: "failed",
        attemptNumber: command.attemptNumber,
        occurredAt: new Date(),
      });
      return { kind: "dead-lettered", reason: result.error };
    }

    const nextAttempt = command.attemptNumber + 1;
    const delayMs = this.retryPolicy.delayBeforeAttempt(nextAttempt);
    if (delayMs === null) {
      await this.deps.messageBroker.publishToDlq(command, result.error);
      await this.deps.messageBroker.publishDeliveryStatus({
        notificationRequestId: command.notificationRequestId,
        status: "failed",
        attemptNumber: command.attemptNumber,
        occurredAt: new Date(),
      });
      return { kind: "dead-lettered", reason: result.error };
    }

    await this.deps.messageBroker.scheduleRetry(
      { ...command, attemptNumber: nextAttempt },
      delayMs,
    );
    return { kind: "retry-scheduled", delayMs };
  }
}
