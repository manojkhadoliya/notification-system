import type { Producer } from "kafkajs";
import type {
  BroadcastChunk,
  BroadcastRequest,
  ChannelCommand,
  DeliveryStatusEvent,
  MessageBroker,
  NotificationEvent,
} from "@notification-system/domain-notification";
import {
  commandTopic,
  DELIVERY_STATUS_TOPIC,
  dlqTopic,
  eventTopic,
  EVENTS_BROADCAST_CHUNKS_TOPIC,
  EVENTS_BROADCAST_TOPIC,
  retryTopic,
} from "./topics.js";

/**
 * Implements `domain-notification`'s `MessageBroker` port (the publish
 * side only — see that port's doc comment; consuming is each
 * composition root's own concern, not abstracted behind this interface).
 * Takes an already-connected kafkajs `Producer`, constructed with
 * `idempotent: true` by the composition root (see `createKafkaProducer`)
 * — messaging.md's "Kafka client's idempotent-producer mode enabled" is a
 * producer-construction setting, not something this class can enforce on
 * a `Producer` handed to it, so it's the composition root's
 * responsibility to have used `createKafkaProducer` rather than a bare
 * `kafka.producer()`.
 */
export class KafkaMessageBroker implements MessageBroker {
  constructor(private readonly producer: Producer) {}

  async publishEvent(event: NotificationEvent): Promise<void> {
    await this.producer.send({
      topic: eventTopic(event.priority),
      messages: [{ key: event.recipientId, value: JSON.stringify(event) }],
    });
  }

  async publishCommand(command: ChannelCommand): Promise<void> {
    await this.producer.send({
      topic: commandTopic(command.channel),
      messages: [{ key: command.recipientId, value: JSON.stringify(command) }],
    });
  }

  async scheduleRetry(command: ChannelCommand, delayMs: number): Promise<void> {
    await this.producer.send({
      topic: retryTopic(command.channel, delayMs),
      messages: [
        {
          key: command.recipientId,
          value: JSON.stringify(command),
          // Publish time + delay = when a retry-tier consumer should
          // actually act on this message ("delay-aware consume, not a
          // busy poll" — messaging.md#retry-ladder). Carried as a header,
          // not a field on the command itself: it's transport-level
          // scheduling metadata, not part of the domain-owned
          // ChannelCommand shape. Reading this header and actually
          // holding the message is the retry-consuming worker's job —
          // not yet built (see roadmap.md).
          headers: { "x-retry-after": String(Date.now() + delayMs) },
        },
      ],
    });
  }

  async publishToDlq(command: ChannelCommand, reason: string): Promise<void> {
    await this.producer.send({
      topic: dlqTopic(command.channel),
      messages: [
        {
          key: command.recipientId,
          value: JSON.stringify({ command, reason }),
        },
      ],
    });
  }

  async publishDeliveryStatus(event: DeliveryStatusEvent): Promise<void> {
    await this.producer.send({
      topic: DELIVERY_STATUS_TOPIC,
      messages: [
        {
          key: event.notificationRequestId,
          value: JSON.stringify(event),
        },
      ],
    });
  }

  async publishBroadcast(request: BroadcastRequest): Promise<void> {
    await this.producer.send({
      topic: EVENTS_BROADCAST_TOPIC,
      messages: [{ key: request.id, value: JSON.stringify(request) }],
    });
  }

  async publishChunk(chunk: BroadcastChunk): Promise<void> {
    await this.producer.send({
      topic: EVENTS_BROADCAST_CHUNKS_TOPIC,
      messages: [{ key: chunk.chunkId, value: JSON.stringify(chunk) }],
    });
  }
}
