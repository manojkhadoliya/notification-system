import type {
  Channel,
  NotificationRequestId,
} from "@notification-system/shared-kernel";

/**
 * The router's output for one event: resolved channel, quiet-hours
 * verdict, and rendered content. Produced once, by `services/router`,
 * never recomputed by a worker — see messaging.md#router and
 * domain-model.md#notification-delivery-core-domain.
 *
 * Modeled as a discriminated union rather than one shape with optional
 * fields: `services/router` (Phase 1, not yet built) branches on `kind`,
 * and a union makes "a suppressed decision has no `channel`" a compile
 * error to get wrong rather than a runtime `undefined`.
 */
export type RoutingDecision =
  | {
      readonly kind: "dispatch";
      readonly notificationRequestId: NotificationRequestId;
      readonly channel: Channel;
      readonly renderedPayload: Record<string, unknown>;
    }
  | {
      readonly kind: "deferred";
      readonly notificationRequestId: NotificationRequestId;
      /** Why this event didn't dispatch immediately — currently only
       * quiet hours defers (see messaging.md#router); listed as a union
       * of one to leave room for a future reason without a breaking
       * change to callers that already switch on this field. */
      readonly reason: "quiet-hours";
      readonly dueAt: Date;
    }
  | {
      readonly kind: "suppressed";
      readonly notificationRequestId: NotificationRequestId;
      readonly reason: "opted-out" | "no-address-for-channel";
    };
