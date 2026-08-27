import type {
  Channel,
  NotificationRequestId,
  Priority,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";

/**
 * The self-contained message a channel worker consumes off
 * `command.{channel}` (and its retry tiers) — fully rendered, not a
 * reference the worker looks up elsewhere. See
 * messaging.md#self-contained-command-payload and ADR 0009.
 */
export interface ChannelCommand {
  readonly notificationRequestId: NotificationRequestId;
  readonly tenantId: TenantId;
  readonly recipientId: RecipientId;
  readonly channel: Channel;
  readonly priority: Priority;
  /** Rendered content — a string body for sms/push/in_app, or a
   * subject+body shape for email; `domain-notification` doesn't interpret
   * this further, only carries and hands it to the gateway. */
  readonly renderedPayload: Record<string, unknown>;
  /** Which attempt this delivery represents — 1 for the first try,
   * incrementing on each retry-tier redelivery. See `RetryPolicy`. */
  readonly attemptNumber: number;
}
