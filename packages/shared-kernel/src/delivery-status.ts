/**
 * `NotificationRequest.status` — see data-model.md#notification-delivery-core-domain
 * and ADR 0010's single-writer state machine. Written **only** by
 * `services/projection-notification`, strictly in this order, never
 * backwards: `accepted -> sent -> delivered`, with `failed` reachable from
 * `accepted` or `sent`.
 *
 * Distinct from `DeliveryAttempt.status` (domain-notification's own
 * `AttemptStatus`, a narrower `sent | failed | delivered` with no
 * `accepted` state — an attempt doesn't exist until it's been made) — this
 * one is the request-level status, which is why it lives in shared-kernel
 * rather than domain-notification alone.
 */
export const DELIVERY_STATUSES = [
  "accepted",
  "sent",
  "delivered",
  "failed",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Valid forward transitions. `failed` is terminal from either `accepted`
 * or `sent`; nothing is valid out of `delivered` or `failed`. */
const ALLOWED_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  accepted: ["sent", "failed"],
  sent: ["delivered", "failed"],
  delivered: [],
  failed: [],
};

/** Is `from -> to` a valid single-writer transition? Used by
 * `services/projection-notification` to discard an out-of-order or
 * regressive status update rather than apply it — see
 * ADR 0010#single-writer-status. */
export function isValidDeliveryStatusTransition(
  from: DeliveryStatus,
  to: DeliveryStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
