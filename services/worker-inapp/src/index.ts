import { DispatchService } from "@notification-system/domain-notification";
import { loadConfig } from "./config.js";
import { FeedWritingInAppGateway } from "./feed-writing-gateway.js";
import { WorkerService } from "./worker-service.js";

// A long retry-tier wait (up to 30 minutes for command.in_app.retry-30m)
// must not stall this worker's other assigned partitions — including
// fresh command.in_app attempt-1 messages — behind it. See
// infra-kafka/src/consumer.ts's `partitionsConsumedConcurrently` doc
// comment (added building services/worker-sms). 12 = 4 topics (main + 3
// retry tiers) x 3 partitions each (see infra/kafka/create-topics.sh) —
// this worker's full assignment, so nothing here ever waits on anything
// else it owns.
const PARTITIONS_CONSUMED_CONCURRENTLY = 12;

/**
 * Real entrypoint — wires concrete `infra-*` adapters and starts
 * consuming. Everything unit-tested lives in `worker-service.ts`/
 * `feed-writing-gateway.ts`/`config.ts` and is exercised against
 * in-memory fakes instead; this file is what `smoke-test.mjs` and a real
 * `pnpm compose:up` run exercise, not the automated test suite.
 *
 * `startTracing` is imported dynamically and awaited before any other
 * module loads — see `services/api/src/index.ts`'s doc comment for why a
 * static top-level `import` can't achieve that ordering under ESM.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const { startTracing } = await import("@notification-system/observability");
  startTracing({ serviceName: "worker-inapp" });

  const [
    {
      PrismaClient,
      PostgresDedupeRepository,
      PostgresNotificationRepository,
      PostgresNotificationFeedRepository,
    },
    {
      createKafka,
      createKafkaProducer,
      KafkaMessageBroker,
      KafkaConsumer,
      commandTopic,
      allRetryTopics,
    },
    { createRedis, RedisRateLimiter, RedisInAppGateway },
  ] = await Promise.all([
    import("@notification-system/infra-postgres"),
    import("@notification-system/infra-kafka"),
    import("@notification-system/infra-redis"),
  ]);

  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const kafka = createKafka({
    brokers: config.kafkaBrokers,
    clientId: config.kafkaClientId,
  });
  const producer = await createKafkaProducer(kafka);
  // One shared connection: RedisRateLimiter/RedisInAppGateway only ever
  // issue plain commands (EVAL, PUBLISH) — the "needs a dedicated
  // connection" constraint (infra-redis's README) is specific to
  // InAppSubscriber's SUBSCRIBE mode, which this worker never enters
  // (that's services/inapp-gateway's job, not this one's).
  const redis = createRedis({ url: config.redisUrl });

  const messageBroker = new KafkaMessageBroker(producer);
  const gateway = new FeedWritingInAppGateway(
    new PostgresNotificationFeedRepository(prisma),
    new RedisInAppGateway(redis),
  );

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
    topics: [commandTopic("in_app"), ...allRetryTopics("in_app")],
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

main().catch((err: unknown) => {
  console.error("services/worker-inapp failed to start:", err);
  process.exitCode = 1;
});
