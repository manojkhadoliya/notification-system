import type { Consumer, Kafka } from "kafkajs";

export interface KafkaConsumerConfig {
  readonly groupId: string;
  readonly topics: string[];
}

export interface ConsumedMessage {
  readonly topic: string;
  readonly key: string | null;
  readonly value: string | null;
  readonly headers: Record<string, string | undefined>;
}

function decodeHeaders(
  headers:
    | Record<string, Buffer | string | (Buffer | string)[] | undefined>
    | undefined,
): Record<string, string | undefined> {
  const decoded: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) {
      continue;
    }
    const single = Array.isArray(value) ? value[0] : value;
    decoded[key] = single === undefined ? undefined : single.toString();
  }
  return decoded;
}

/**
 * A thin, generic wrapper over a kafkajs `Consumer` — not a domain port
 * (see `MessageBroker`'s doc comment: consuming isn't abstracted behind a
 * domain interface, since which topics/how to react is inherently
 * per-service). Every `services/*` composition root that consumes
 * (`router`, the channel workers, `projection-notification`,
 * `scheduler`, `fanout-expander`) is expected to use this directly rather
 * than reaching for kafkajs itself, so topic subscription and message
 * decoding stay consistent across all of them.
 *
 * Deliberately does **not** implement the retry ladder's "hold until the
 * tier's backoff has elapsed" behavior (see
 * messaging.md#retry-ladder--one-consumer-per-channel-all-tiers and the
 * `x-retry-after` header `KafkaMessageBroker.scheduleRetry` sets) — that's
 * business timing logic for the channel workers to implement using this
 * wrapper plus that header, not something a generic Kafka client wrapper
 * should decide. Not yet built — see roadmap.md.
 */
export class KafkaConsumer {
  private readonly consumer: Consumer;

  constructor(
    kafka: Kafka,
    private readonly config: KafkaConsumerConfig,
  ) {
    this.consumer = kafka.consumer({ groupId: config.groupId });
  }

  async start(
    handler: (message: ConsumedMessage) => Promise<void>,
  ): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: this.config.topics,
      fromBeginning: false,
    });
    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        await handler({
          topic,
          key: message.key === null ? null : message.key.toString(),
          value: message.value === null ? null : message.value.toString(),
          headers: decodeHeaders(message.headers),
        });
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}
