export interface ProjectionNotificationConfig {
  readonly databaseUrl: string;
  readonly kafkaBrokers: string[];
  readonly kafkaClientId: string;
  readonly kafkaGroupId: string;
}

/** Takes an env object rather than reading `process.env` internally so
 * it's a pure, unit-testable function — same pattern as every other
 * `services/*` `config.ts` this session. */
export function loadConfig(
  env: NodeJS.ProcessEnv,
): ProjectionNotificationConfig {
  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    kafkaBrokers: requireEnv(env, "KAFKA_BROKERS").split(","),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? "projection-notification",
    kafkaGroupId: env.KAFKA_GROUP_ID ?? "projection-notification",
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
