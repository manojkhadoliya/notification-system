export interface RouterConfig {
  readonly databaseUrl: string;
  readonly kafkaBrokers: string[];
  readonly kafkaClientId: string;
  readonly kafkaGroupId: string;
}

/** Takes an env object rather than reading `process.env` internally so
 * it's a pure, unit-testable function — same pattern as
 * `services/api/src/config.ts`; only `index.ts` calls this with the real
 * `process.env`. No `REDIS_URL` — see this package's README on why the
 * read-through preference cache scaling-strategy.md describes isn't
 * wired in this pass. */
export function loadConfig(env: NodeJS.ProcessEnv): RouterConfig {
  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    kafkaBrokers: requireEnv(env, "KAFKA_BROKERS").split(","),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? "services-router",
    kafkaGroupId: env.KAFKA_GROUP_ID ?? "services-router",
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
