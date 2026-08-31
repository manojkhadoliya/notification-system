import { randomUUID } from "node:crypto";
import type {
  ChannelCommand,
  GatewaySendResult,
  InAppGateway,
  NotificationFeedRepository,
} from "@notification-system/domain-notification";
import { NotificationFeedItem } from "@notification-system/domain-notification";

/** `services/router`'s `build-channel-payload.ts` sends `in_app` a plain
 * `{ body: string }` (no external address needed — see that module's doc
 * comment). Throws if it doesn't match, same "malformed payload is a
 * router bug, not a transient failure" treatment `providers-sms`/`-push`/
 * `-email`'s own payload parsers use. */
function parseInAppPayload(renderedPayload: Record<string, unknown>): {
  body: string;
} {
  const { body } = renderedPayload;
  if (typeof body !== "string" || body.length === 0) {
    throw new Error("in_app renderedPayload.body must be a non-empty string");
  }
  return { body };
}

/**
 * `InAppGateway` port implementation for `services/worker-inapp` — the
 * one piece that makes `in_app` "structurally different" (see
 * messaging.md#in-app-is-structurally-different and ADR 0012): instead of
 * calling an external provider, `send()` writes a `NotificationFeedItem`
 * row first, *then* delegates to `infra-redis`'s `RedisInAppGateway` for
 * the pub/sub nudge to a live socket. Composed here rather than inside
 * `infra-redis` itself, since the feed write is this worker's job, not a
 * generic Redis adapter's.
 *
 * The feed write is idempotent (see `NotificationFeedRepository.save`'s
 * doc comment), so a redelivered attempt — including one where the
 * *pub/sub* half below failed and `DispatchService` retried the whole
 * `send()` — safely re-runs both steps rather than double-writing.
 */
export class FeedWritingInAppGateway implements InAppGateway {
  constructor(
    private readonly feedRepository: NotificationFeedRepository,
    private readonly pubsubGateway: InAppGateway,
  ) {}

  async send(command: ChannelCommand): Promise<GatewaySendResult> {
    let payload: { body: string };
    try {
      payload = parseInAppPayload(command.renderedPayload);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    }

    const item = NotificationFeedItem.write({
      id: randomUUID(),
      recipientId: command.recipientId,
      notificationRequestId: command.notificationRequestId,
      summary: payload.body,
    });
    try {
      await this.feedRepository.save(item);
    } catch (err) {
      // A Postgres write failure is transient from this adapter's point
      // of view — the feed row is the durable half of "delivery" here
      // (see messaging.md's "always write a NotificationFeedItem...
      // regardless"), so it's worth retrying rather than dead-lettering.
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }

    // Best-effort nudge to a live socket — see RedisInAppGateway's own
    // doc comment: a publish with no subscriber still succeeds, since
    // the feed row just written above is the durable delivery.
    return this.pubsubGateway.send(command);
  }
}
