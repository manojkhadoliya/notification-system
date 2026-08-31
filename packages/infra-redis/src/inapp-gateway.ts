import type { Redis } from "ioredis";
import type {
  ChannelCommand,
  GatewaySendResult,
  InAppGateway,
} from "@notification-system/domain-notification";
import {
  INAPP_PUBSUB_CHANNEL,
  type InAppNotification,
} from "./inapp-message.js";

/**
 * `InAppGateway` port implementation — the "deliver to a live socket if
 * one's connected" half of in-app delivery (see
 * messaging.md#in-app-is-structurally-different and ADR 0012).
 * `services/worker-inapp` writes the `NotificationFeedItem` row itself
 * (via a future feed-repository port — not this one, and not built yet)
 * *before* calling this; publishing here is a best-effort nudge to
 * whichever `inapp-gateway` replica, if any, holds the recipient's
 * socket. A publish with zero subscribers still returns
 * `success: true` — "nobody was listening right now" isn't a delivery
 * failure once the feed row exists, since the recipient will see it next
 * time they open the feed regardless.
 */
export class RedisInAppGateway implements InAppGateway {
  constructor(private readonly redis: Redis) {}

  async send(command: ChannelCommand): Promise<GatewaySendResult> {
    const message: InAppNotification = {
      notificationRequestId: command.notificationRequestId,
      tenantId: command.tenantId,
      recipientId: command.recipientId,
      renderedPayload: command.renderedPayload,
    };
    try {
      await this.redis.publish(INAPP_PUBSUB_CHANNEL, JSON.stringify(message));
      return { success: true };
    } catch (err) {
      // A publish failure (e.g. connection drop) is transient — retrying
      // costs nothing beyond another best-effort nudge, and the feed row
      // (already written by the caller) is the durable delivery, not this.
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
  }
}
