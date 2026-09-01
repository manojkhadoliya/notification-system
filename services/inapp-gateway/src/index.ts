import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { pushToRegistry } from "./notify.js";

/**
 * Real entrypoint — wires the WebSocket registry to a live Redis
 * subscription and starts listening. Everything unit-tested lives in
 * `server.ts`/`connection-registry.ts`/`notify.ts`/`config.ts` and is
 * exercised without a real Redis or network dependency where possible
 * (`server.ts`'s tests do open real loopback sockets — see its doc
 * comment for why that's still not "live infra"); this file is what
 * `scripts/smoke-test.mjs` and a real `pnpm compose:up` run exercise,
 * not the automated test suite.
 *
 * `startTracing` is imported dynamically and awaited before any other
 * module loads — see `services/api/src/index.ts`'s doc comment for why a
 * static top-level `import` can't achieve that ordering under ESM.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const { startTracing } = await import("@notification-system/observability");
  startTracing({ serviceName: "inapp-gateway" });

  const { createRedis, InAppSubscriber } =
    await import("@notification-system/infra-redis");

  // A dedicated connection, per infra-redis's own README: once an ioredis
  // connection issues SUBSCRIBE it can't run any other command, unlike
  // worker-inapp's shared client (which only ever PUBLISHes/EVALs — see
  // its index.ts doc comment).
  const redis = createRedis({ url: config.redisUrl });
  const subscriber = new InAppSubscriber(redis);

  const gateway = buildServer();
  await subscriber.start((notification) => {
    pushToRegistry(gateway.registry, notification);
  });

  await new Promise<void>((resolve) =>
    gateway.httpServer.listen(config.port, config.host, resolve),
  );
  console.log(
    `services/inapp-gateway listening on ${config.host}:${config.port}`,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await subscriber.stop();
    await gateway.close();
    await redis.quit();
    // startTracing registers its own SIGTERM/SIGINT shutdown hook for
    // the OTel SDK — nothing further to do for it here.
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error("services/inapp-gateway failed to start:", err);
  process.exitCode = 1;
});
