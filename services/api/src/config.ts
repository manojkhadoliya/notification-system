export interface ApiConfig {
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly kafkaBrokers: string[];
  readonly kafkaClientId: string;
}

/** Reads `.env.example`'s vars — takes an env object rather than reading
 * `process.env` internally so it's a pure, unit-testable function; only
 * `index.ts` (the real entrypoint) ever calls this with the real
 * `process.env`. */
export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    redisUrl: requireEnv(env, "REDIS_URL"),
    kafkaBrokers: requireEnv(env, "KAFKA_BROKERS").split(","),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? "services-api",
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
