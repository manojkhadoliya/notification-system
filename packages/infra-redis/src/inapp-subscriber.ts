import type { Redis } from "ioredis";
import {
  INAPP_PUBSUB_CHANNEL,
  type InAppNotification,
} from "./inapp-message.js";

/**
 * Consuming-side wrapper for `services/inapp-gateway` (not yet built) —
 * same role as `infra-kafka`'s `KafkaConsumer`: a plain infra wrapper, not
 * a domain port, since "subscribe and push to a live socket" is
 * per-composition-root reaction logic, not something to abstract behind a
 * domain interface (mirrors `MessageBroker`'s own publish-only-port doc
 * comment in `domain-notification/src/ports.ts`).
 *
 * `redis` must be a connection dedicated to this subscriber — once an
 * ioredis connection issues `SUBSCRIBE` it can't run any other command,
 * so callers must pass `someOtherClient.duplicate()`, never a client also
 * used for `RedisRateLimiter`/`RedisIdempotencyStore`/`RedisInAppGateway`.
 */
export class InAppSubscriber {
  constructor(private readonly redis: Redis) {}

  async start(
    onNotification: (notification: InAppNotification) => void,
  ): Promise<void> {
    this.redis.on("message", (channel: string, raw: string) => {
      if (channel !== INAPP_PUBSUB_CHANNEL) return;
      onNotification(JSON.parse(raw) as InAppNotification);
    });
    await this.redis.subscribe(INAPP_PUBSUB_CHANNEL);
  }

  async stop(): Promise<void> {
    await this.redis.unsubscribe(INAPP_PUBSUB_CHANNEL);
  }
}
