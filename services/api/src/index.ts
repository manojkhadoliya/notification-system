import { loadConfig } from "./config.js";

/**
 * Real entrypoint — wires concrete `infra-*` adapters and starts
 * listening. Everything unit-tested lives in `server.ts`/`routes/*` and
 * is exercised against in-memory fakes instead; this file is what
 * `smoke-test.mjs` and a real `pnpm compose:up` run exercise, not the
 * automated test suite.
 *
 * `startTracing` (and everything it auto-instruments — pg, ioredis,
 * kafkajs, the HTTP server itself) is imported dynamically and awaited
 * before any other module loads, per its own doc comment: "before
 * importing anything that should be auto-instrumented... patches modules
 * at require/import time." A static top-level `import` would defeat that
 * — ESM hoists every static import above this function body regardless
 * of where it's written, so only a dynamic `import()` inside `main()`
 * actually orders it first.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const { startTracing } = await import("@notification-system/observability");
  startTracing({ serviceName: "services-api" });

  const [
    {
      PrismaClient,
      PostgresApiKeyRepository,
      PostgresNotificationRepository,
      PostgresPreferenceRepository,
      PostgresTemplateRepository,
    },
    { createKafka, createKafkaProducer, KafkaMessageBroker },
    { createRedis, RedisIdempotencyStore, RedisRateLimiter },
    { buildServer },
  ] = await Promise.all([
    import("@notification-system/infra-postgres"),
    import("@notification-system/infra-kafka"),
    import("@notification-system/infra-redis"),
    import("./server.js"),
  ]);

  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const kafka = createKafka({
    brokers: config.kafkaBrokers,
    clientId: config.kafkaClientId,
  });
  const producer = await createKafkaProducer(kafka);
  const redis = createRedis({ url: config.redisUrl });

  const app = buildServer(
    {
      apiKeyRepository: new PostgresApiKeyRepository(prisma),
      notificationRepository: new PostgresNotificationRepository(prisma),
      preferenceRepository: new PostgresPreferenceRepository(prisma),
      templateRepository: new PostgresTemplateRepository(prisma),
      messageBroker: new KafkaMessageBroker(producer),
      idempotencyStore: new RedisIdempotencyStore(redis),
      rateLimiter: new RedisRateLimiter(redis),
    },
    { logger: true },
  );

  await app.listen({ port: config.port, host: config.host });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    await producer.disconnect();
    await redis.quit();
    await prisma.$disconnect();
    // startTracing registers its own SIGTERM/SIGINT shutdown hook for
    // the OTel SDK — nothing further to do for it here.
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error("services/api failed to start:", err);
  process.exitCode = 1;
});
