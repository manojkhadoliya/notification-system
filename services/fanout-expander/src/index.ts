import { PreferenceAudienceResolver } from "./audience-resolver.js";
import { loadConfig } from "./config.js";
import { FanoutExpanderService } from "./fanout-expander-service.js";

/**
 * Real entrypoint — wires concrete `infra-*` adapters and starts
 * consuming. Everything unit-tested lives in
 * `fanout-expander-service.ts`/`audience-resolver.ts`/
 * `deterministic-id.ts`/`config.ts` and is exercised against in-memory
 * fakes instead; this file is what `scripts/smoke-test.mjs` and a real
 * `pnpm compose:up` run exercise, not the automated test suite.
 *
 * `startTracing` is imported dynamically and awaited before any other
 * module loads — see `services/api/src/index.ts`'s doc comment for why a
 * static top-level `import` can't achieve that ordering under ESM.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const { startTracing } = await import("@notification-system/observability");
  startTracing({ serviceName: "fanout-expander" });

  const [
    { PrismaClient, PostgresPreferenceRepository },
    {
      createKafka,
      createKafkaProducer,
      KafkaMessageBroker,
      KafkaConsumer,
      EVENTS_BROADCAST_TOPIC,
      EVENTS_BROADCAST_CHUNKS_TOPIC,
    },
  ] = await Promise.all([
    import("@notification-system/infra-postgres"),
    import("@notification-system/infra-kafka"),
  ]);

  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const kafka = createKafka({
    brokers: config.kafkaBrokers,
    clientId: config.kafkaClientId,
  });
  const producer = await createKafkaProducer(kafka);

  const fanoutExpanderService = new FanoutExpanderService({
    audienceResolver: new PreferenceAudienceResolver(
      new PostgresPreferenceRepository(prisma),
    ),
    messageBroker: new KafkaMessageBroker(producer),
  });

  const consumer = new KafkaConsumer(kafka, {
    groupId: config.kafkaGroupId,
    topics: [EVENTS_BROADCAST_TOPIC, EVENTS_BROADCAST_CHUNKS_TOPIC],
  });

  await consumer.start((message) => fanoutExpanderService.handle(message));

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await consumer.stop();
    await producer.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error("services/fanout-expander failed to start:", err);
  process.exitCode = 1;
});
