import type { NotificationEvent } from "@notification-system/domain-notification";
import { loadConfig } from "./config.js";
import { RouterService } from "./router-service.js";

const EVENT_TOPICS_BY_PRIORITY = ["critical", "standard", "bulk"] as const;

/**
 * Real entrypoint — wires concrete `infra-*` adapters and starts
 * consuming. Everything unit-tested lives in `router-service.ts`/
 * `routing.ts`/`render-template.ts`/`build-channel-payload.ts` and is
 * exercised against in-memory fakes instead; this file is what
 * `smoke-test.mjs` and a real `pnpm compose:up` run exercise, not the
 * automated test suite.
 *
 * `startTracing` (and everything it auto-instruments) is imported
 * dynamically and awaited before any other module loads — see
 * `services/api/src/index.ts`'s doc comment for why a static top-level
 * `import` can't achieve that ordering under ESM.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const { startTracing } = await import("@notification-system/observability");
  startTracing({ serviceName: "services-router" });

  const [
    {
      PrismaClient,
      PostgresPreferenceRepository,
      PostgresTemplateRepository,
      PostgresScheduledNotificationRepository,
    },
    {
      createKafka,
      createKafkaProducer,
      KafkaMessageBroker,
      KafkaConsumer,
      eventTopic,
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

  const router = new RouterService({
    preferenceRepository: new PostgresPreferenceRepository(prisma),
    templateRepository: new PostgresTemplateRepository(prisma),
    scheduledNotificationRepository:
      new PostgresScheduledNotificationRepository(prisma),
    messageBroker: new KafkaMessageBroker(producer),
  });

  const consumer = new KafkaConsumer(kafka, {
    groupId: config.kafkaGroupId,
    topics: EVENT_TOPICS_BY_PRIORITY.map((priority) => eventTopic(priority)),
  });

  await consumer.start(async (message) => {
    if (message.value === null) {
      return;
    }
    let event: NotificationEvent;
    try {
      event = JSON.parse(message.value) as NotificationEvent;
    } catch (err) {
      // A malformed message on the event backbone is a producer bug, not
      // something retrying this same bytes will ever fix — log and move
      // on rather than crashing the whole consumer loop over one message.
      console.error(
        `services/router: failed to parse a message on ${message.topic}, skipping`,
        err,
      );
      return;
    }
    await router.handle(event);
  });

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
  console.error("services/router failed to start:", err);
  process.exitCode = 1;
});
