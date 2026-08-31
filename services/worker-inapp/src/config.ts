export interface WorkerInappConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly kafkaBrokers: string[];
  readonly kafkaClientId: string;
  readonly kafkaGroupId: string;
}

/** Takes an env object rather than reading `process.env` internally so
 * it's a pure, unit-testable function — same pattern as
 * `services/worker-sms`/`-push`/`-email`'s `config.ts`; only `index.ts`
 * calls this with the real `process.env`. No provider-selection branch —
 * `in_app` has no external provider to select between (see
 * `messaging.md#in-app-is-structurally-different`); the "gateway" here is
 * always `infra-redis`'s pub/sub. */
export function loadConfig(env: NodeJS.ProcessEnv): WorkerInappConfig {
  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    redisUrl: requireEnv(env, "REDIS_URL"),
    kafkaBrokers: requireEnv(env, "KAFKA_BROKERS").split(","),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? "worker-inapp",
    kafkaGroupId: env.KAFKA_GROUP_ID ?? "worker-inapp",
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
