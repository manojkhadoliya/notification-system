import { loadConfig } from "./config.js";
import { ProjectionService } from "./projection-service.js";

/**
 * Real entrypoint — wires concrete `infra-*` adapters and starts
 * consuming. Everything unit-tested lives in `projection-service.ts`/
 * `config.ts` and is exercised against in-memory fakes instead; this
 * file is what `scripts/smoke-test.mjs` and a real `pnpm compose:up` run
 * exercise, not the automated test suite.
 *
 * Consumes exactly one topic — `delivery-status` — not `events.*` +
 * `delivery-status`; see `ProjectionService`'s doc comment for why.
 *
 * `startTracing` is imported dynamically and awaited before any other
 * module loads — see `services/api/src/index.ts`'s doc comment for why a
 * static top-level `import` can't achieve that ordering under ESM.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const { startTracing } = await import("@notification-system/observability");
  startTracing({ serviceName: "projection-notification" });

  const [
    { PrismaClient, PostgresNotificationRepository },
    { createKafka, KafkaConsumer, DELIVERY_STATUS_TOPIC },
  ] = await Promise.all([
    import("@notification-system/infra-postgres"),
    import("@notification-system/infra-kafka"),
  ]);

  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const kafka = createKafka({
    brokers: config.kafkaBrokers,
    clientId: config.kafkaClientId,
  });

  const projectionService = new ProjectionService({
    notificationRepository: new PostgresNotificationRepository(prisma),
  });

  const consumer = new KafkaConsumer(kafka, {
    groupId: config.kafkaGroupId,
    topics: [DELIVERY_STATUS_TOPIC],
  });

  await consumer.start((message) => projectionService.handle(message));

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await consumer.stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error("services/projection-notification failed to start:", err);
  process.exitCode = 1;
});
