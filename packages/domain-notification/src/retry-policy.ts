/**
 * Backoff schedule and max-attempts rule applied before a `DeliveryAttempt`
 * is routed to the dead-letter queue — see domain-model.md#notification-delivery-core-domain
 * and ADR 0010's retry ladder: `command.{channel}.retry-30s/-5m/-30m`, one
 * consumer per channel handling all three tiers itself (see
 * messaging.md#retry-ladder--one-consumer-per-channel-all-tiers) — this
 * class only decides the *policy* (how long to wait, when to give up);
 * which topic that maps to is `infra-kafka`'s job.
 */
export class RetryPolicy {
  private static readonly TIER_DELAYS_MS = [
    30_000, 300_000, 1_800_000,
  ] as const;

  /** 1 initial attempt + 3 retry tiers. */
  static readonly maxAttempts = RetryPolicy.TIER_DELAYS_MS.length + 1;

  /**
   * How long to wait, in ms, before making `attemptNumber`. Attempt 1 (the
   * first try) has no delay. Returns `null` once attempts are exhausted —
   * the caller routes to the DLQ instead of retrying again.
   */
  delayBeforeAttempt(attemptNumber: number): number | null {
    if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
      throw new Error("attemptNumber must be a positive integer");
    }
    if (attemptNumber === 1) {
      return 0;
    }
    const tierIndex = attemptNumber - 2; // attempt 2 -> tier 0 (30s), etc.
    const delay = RetryPolicy.TIER_DELAYS_MS[tierIndex];
    return delay ?? null;
  }

  /** True once `attemptNumber` has no further tier to retry into — the
   * message belongs on the DLQ, not another retry topic. */
  isExhausted(attemptNumber: number): boolean {
    return attemptNumber > RetryPolicy.maxAttempts;
  }
}
