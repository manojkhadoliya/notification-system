import {
  DispatchService,
  type SmsGateway,
} from "@notification-system/domain-notification";
import { loadConfig, type GatewayConfig } from "./config.js";
import { WorkerService } from "./worker-service.js";

// A long retry-tier wait (up to 30 minutes for command.sms.retry-30m)
// must not stall this worker's other assigned partitions — including
// fresh command.sms attempt-1 messages — behind it. See
// infra-kafka/src/consumer.ts's `partitionsConsumedConcurrently` doc
// comment. 12 = 4 topics (main + 3 retry tiers) x 3 partitions each (see
// infra/kafka/create-topics.sh) — this worker's full assignment, so
// nothing here ever waits on anything else it owns.
const PARTITIONS_CONSUMED_CONCURRENTLY = 12;

/**
 * Real entrypoint — wires concrete `infra-*`/`providers-sms` adapters and
 * starts consuming. Everything unit-tested lives in `worker-service.ts`/
 * `config.ts` and is exercised against in-memory fakes instead; this file
 * is what `smoke-test.mjs` and a real `pnpm compose:up` run exercise, not
 * the automated test suite.
 *
 * `startTracing` is imported dynamically and awaited before any other
 * module loads — see `services/api/src/index.ts`'s doc comment for why a
 * static top-level `import` can't achieve that ordering under ESM.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const { startTracing } = await import("@notification-system/observability");
  startTracing({ serviceName: "worker-sms" });

  const [
    { PrismaClient, PostgresDedupeRepository, PostgresNotificationRepository },
    {
      createKafka,
      createKafkaProducer,
      KafkaMessageBroker,
      KafkaConsumer,
      commandTopic,
      allRetryTopics,
    },
    { createRedis, RedisRateLimiter },
    { TwilioSmsGateway, MockSmsGateway },
  ] = await Promise.all([
    import("@notification-system/infra-postgres"),
    import("@notification-system/infra-kafka"),
    import("@notification-system/infra-redis"),
    import("@notification-system/providers-sms"),
  ]);

  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const kafka = createKafka({
    brokers: config.kafkaBrokers,
    clientId: config.kafkaClientId,
  });
  const producer = await createKafkaProducer(kafka);
  const redis = createRedis({ url: config.redisUrl });

  const gateway: SmsGateway = buildGateway(
    config.gateway,
    TwilioSmsGateway,
    MockSmsGateway,
  );
  const messageBroker = new KafkaMessageBroker(producer);

  const dispatchService = new DispatchService({
    gateway,
    dedupeRepository: new PostgresDedupeRepository(prisma),
    rateLimiter: new RedisRateLimiter(redis),
    messageBroker,
  });

  const workerService = new WorkerService({
    dispatchService,
    notificationRepository: new PostgresNotificationRepository(prisma),
    messageBroker,
  });

  const consumer = new KafkaConsumer(kafka, {
    groupId: config.kafkaGroupId,
    topics: [commandTopic("sms"), ...allRetryTopics("sms")],
    partitionsConsumedConcurrently: PARTITIONS_CONSUMED_CONCURRENTLY,
  });

  await consumer.start((message) => workerService.handle(message));

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await consumer.stop();
    await producer.disconnect();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

function buildGateway(
  config: GatewayConfig,
  TwilioSmsGateway: new (config: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
  }) => SmsGateway,
  MockSmsGateway: new (options?: {
    successRate?: number;
    latencyMs?: number;
  }) => SmsGateway,
): SmsGateway {
  if (config.kind === "twilio") {
    return new TwilioSmsGateway({
      accountSid: config.accountSid,
      authToken: config.authToken,
      fromNumber: config.fromNumber,
    });
  }
  return new MockSmsGateway({
    ...(config.successRate !== undefined
      ? { successRate: config.successRate }
      : {}),
    ...(config.latencyMs !== undefined ? { latencyMs: config.latencyMs } : {}),
  });
}

main().catch((err: unknown) => {
  console.error("services/worker-sms failed to start:", err);
  process.exitCode = 1;
});
