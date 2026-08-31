import type {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";

/** Single global pub/sub channel — every `inapp-gateway` replica
 * subscribes to it and filters by `recipientId` locally, since a Redis
 * `PUBLISH` fans out to all subscribers and no replica knows in advance
 * which recipients' sockets it holds (see ADR 0012: "pub/sub lets any
 * `worker-inapp` instance announce a feed write without needing to know
 * which gateway instance, if any, holds the relevant socket"). */
export const INAPP_PUBSUB_CHANNEL = "inapp:notifications";

/** What `RedisInAppGateway.send` publishes and `InAppSubscriber` decodes.
 * Carries `renderedPayload` through unchanged (same shape as
 * `ChannelCommand.renderedPayload`) rather than inventing an undocumented
 * "summary" field — `domain-notification` doesn't interpret this
 * content, so neither does this transport; `inapp-gateway` (not yet
 * built) decides what to push to the socket. */
export interface InAppNotification {
  readonly notificationRequestId: NotificationRequestId;
  readonly tenantId: TenantId;
  readonly recipientId: RecipientId;
  readonly renderedPayload: Record<string, unknown>;
}
