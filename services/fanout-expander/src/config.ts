export interface FanoutExpanderConfig {
  readonly databaseUrl: string;
  readonly kafkaBrokers: string[];
  readonly kafkaClientId: string;
  readonly kafkaGroupId: string;
}

/** Takes an env object rather than reading `process.env` internally so
 * it's a pure, unit-testable function — same pattern as every other
 * `services/*` `config.ts` this session. `databaseUrl` is required here
 * (unlike `services/scheduler`) because `PreferenceAudienceResolver`
 * needs `PostgresPreferenceRepository` to resolve an audience. */
export function loadConfig(env: NodeJS.ProcessEnv): FanoutExpanderConfig {
  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    kafkaBrokers: requireEnv(env, "KAFKA_BROKERS").split(","),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? "fanout-expander",
    kafkaGroupId: env.KAFKA_GROUP_ID ?? "fanout-expander",
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
