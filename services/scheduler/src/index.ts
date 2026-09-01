import { loadConfig } from "./config.js";
import { SchedulerService } from "./scheduler-service.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Real entrypoint — wires concrete `infra-*` adapters and runs the poll
 * loop. Everything unit-tested lives in `scheduler-service.ts`/
 * `config.ts` and is exercised against in-memory fakes instead; this
 * file is what `scripts/smoke-test.mjs` and a real `pnpm compose:up` run
 * exercise, not the automated test suite.
 *
 * Unlike every other `services/*` composition root in this repo, this
 * process isn't Kafka-consumer-group-driven (`services/scheduler` has no
 * consumer group at all — it only ever produces) — it drives its own
 * poll loop on a plain `setTimeout` interval, so shutdown here waits for
 * the current cycle to finish and the flag to be checked, rather than
 * calling `process.exit()` straight from the signal handler the way the
 * consumer-driven workers do.
 *
 * `startTracing` is imported dynamically and awaited before any other
 * module loads — see `services/api/src/index.ts`'s doc comment for why a
 * static top-level `import` can't achieve that ordering under ESM.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const { startTracing } = await import("@notification-system/observability");
  startTracing({ serviceName: "scheduler" });

  const [
    { PrismaClient, PostgresScheduledNotificationRepository },
    { createKafka, createKafkaProducer, KafkaMessageBroker },
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

  const scheduler = new SchedulerService(
    {
      scheduledNotificationRepository:
        new PostgresScheduledNotificationRepository(prisma),
      messageBroker: new KafkaMessageBroker(producer),
    },
    {
      bucket: config.bucket,
      bucketCount: config.bucketCount,
      claimLimit: config.claimLimit,
    },
  );

  let shuttingDown = false;
  process.on("SIGTERM", () => {
    shuttingDown = true;
  });
  process.on("SIGINT", () => {
    shuttingDown = true;
  });

  console.log(
    `services/scheduler: polling shard ${config.bucket}/${config.bucketCount} ` +
      `every ${config.pollIntervalMs}ms`,
  );
  while (!shuttingDown) {
    try {
      const count = await scheduler.pollOnce();
      if (count > 0) {
        console.log(`services/scheduler: emitted ${count} due notification(s)`);
      }
    } catch (err) {
      // A whole poll cycle failing (e.g. a lost Postgres connection) is
      // logged and retried on the next tick, not fatal — matches
      // pollOnce's own per-row error handling (see its doc comment).
      console.error("services/scheduler: poll cycle failed", err);
    }
    if (shuttingDown) break;
    await sleep(config.pollIntervalMs);
  }

  await producer.disconnect();
  await prisma.$disconnect();
  // startTracing registers its own SIGTERM/SIGINT shutdown hook for the
  // OTel SDK — nothing further to do for it here.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("services/scheduler failed to start:", err);
  process.exitCode = 1;
});
