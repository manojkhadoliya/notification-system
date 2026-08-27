import type {
  Channel,
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";

/**
 * A conditional claim on `(tenantId, notificationRequestId, recipientId,
 * channel)`, taken by a worker immediately before the provider call, so an
 * at-least-once redelivery never repeats a send. This is a correctness
 * invariant, not a tunable — see ADR 0010 and
 * messaging.md#dedupe-claim-before-the-provider-call.
 *
 * The claim *is* the insert: `DedupeRepository.tryClaim` either succeeds
 * (first time seeing this key — proceed to call the provider) or fails
 * (already claimed — the provider was already called, or is being called
 * right now; don't call it again). There's no separate "check, then
 * insert" — that race is exactly what a unique-constraint conditional
 * write closes.
 */
export interface DedupeClaim {
  readonly tenantId: TenantId;
  readonly notificationRequestId: NotificationRequestId;
  readonly recipientId: RecipientId;
  readonly channel: Channel;
  readonly claimedAt: Date;
}

export function dedupeClaimKey(
  claim: Pick<
    DedupeClaim,
    "tenantId" | "notificationRequestId" | "recipientId" | "channel"
  >,
): string {
  return `${claim.tenantId}:${claim.notificationRequestId}:${claim.recipientId}:${claim.channel}`;
}
