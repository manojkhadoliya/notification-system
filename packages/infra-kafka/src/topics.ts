import type { Channel, Priority } from "@notification-system/shared-kernel";

/**
 * Topic-name builders — the single source of truth for the topology in
 * messaging.md#topic-layout. Kept in one place because two independent
 * things need to agree on these names: `KafkaMessageBroker` (producing)
 * and, later, every `services/*` composition root (consuming). Also
 * mirrored in [`infra/kafka/create-topics.sh`](../../../infra/kafka/create-topics.sh)
 * — if you rename something here, rename it there too.
 */

export function eventTopic(priority: Priority): string {
  return `events.${priority}`;
}

export const EVENTS_BROADCAST_TOPIC = "events.broadcast";
export const EVENTS_BROADCAST_CHUNKS_TOPIC = "events.broadcast.chunks";

export function commandTopic(channel: Channel): string {
  return `command.${channel}`;
}

export function dlqTopic(channel: Channel): string {
  return `command.${channel}.dlq`;
}

export const DELIVERY_STATUS_TOPIC = "delivery-status";

/** The three retry-tier delays `RetryPolicy` produces, and the topic
 * suffix each maps to — see ADR 0010's retry ladder. Deliberately a
 * lookup, not a formula: an unrecognized delay means something upstream
 * (almost certainly `RetryPolicy`) changed without this map being
 * updated, and that should fail loudly, not silently produce to a made-up
 * topic name. */
const RETRY_TIER_SUFFIX_BY_DELAY_MS: ReadonlyMap<number, string> = new Map([
  [30_000, "retry-30s"],
  [300_000, "retry-5m"],
  [1_800_000, "retry-30m"],
]);

export function retryTopic(channel: Channel, delayMs: number): string {
  const suffix = RETRY_TIER_SUFFIX_BY_DELAY_MS.get(delayMs);
  if (suffix === undefined) {
    throw new Error(
      `No retry tier is configured for a ${delayMs}ms delay (channel: ${channel}). ` +
        "This should only ever be called with a delay RetryPolicy.delayBeforeAttempt produced.",
    );
  }
  return `command.${channel}.${suffix}`;
}

/** Every topic `pnpm kafka:topics` creates, for tests/tooling that need
 * the full list rather than building names one at a time. */
export function allRetryTopics(channel: Channel): string[] {
  return [...RETRY_TIER_SUFFIX_BY_DELAY_MS.values()].map(
    (suffix) => `command.${channel}.${suffix}`,
  );
}
