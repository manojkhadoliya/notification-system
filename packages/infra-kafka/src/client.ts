import { Kafka, type Producer } from "kafkajs";

export interface KafkaConnectionConfig {
  readonly brokers: string[];
  readonly clientId: string;
}

/** Composition roots read `brokers`/`clientId` from their own env config
 * and pass it in — this package never reads `process.env` itself (same
 * pattern as `infra-postgres` taking an already-constructed
 * `PrismaClient`). */
export function createKafka(config: KafkaConnectionConfig): Kafka {
  return new Kafka({ clientId: config.clientId, brokers: config.brokers });
}

/**
 * Idempotent producer mode — see
 * messaging.md#message-flow ("with the Kafka client's idempotent-producer
 * mode enabled"). This is the only correct way to construct the
 * `Producer` handed to `KafkaMessageBroker`; a bare `kafka.producer()`
 * would silently lose that guarantee.
 */
export async function createKafkaProducer(kafka: Kafka): Promise<Producer> {
  const producer = kafka.producer({ idempotent: true });
  await producer.connect();
  return producer;
}
