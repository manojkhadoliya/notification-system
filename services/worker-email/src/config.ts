export interface WorkerEmailConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly kafkaBrokers: string[];
  readonly kafkaClientId: string;
  readonly kafkaGroupId: string;
  readonly mockSuccessRate?: number;
  readonly mockLatencyMs?: number;
}

/** Takes an env object rather than reading `process.env` internally so
 * it's a pure, unit-testable function — same pattern as
 * `services/worker-sms`/`-push`'s `config.ts`; only `index.ts` calls
 * this with the real `process.env`.
 *
 * No provider-selection branch here — `providers-email` currently ships
 * only `MockEmailGateway`, by explicit decision (see
 * `providers-email/README.md`: a real SES/SendGrid adapter is
 * deliberately deferred). `MOCK_EMAIL_SUCCESS_RATE`/`MOCK_EMAIL_LATENCY_MS`
 * are optional. */
export function loadConfig(env: NodeJS.ProcessEnv): WorkerEmailConfig {
  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    redisUrl: requireEnv(env, "REDIS_URL"),
    kafkaBrokers: requireEnv(env, "KAFKA_BROKERS").split(","),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? "worker-email",
    kafkaGroupId: env.KAFKA_GROUP_ID ?? "worker-email",
    ...(env.MOCK_EMAIL_SUCCESS_RATE !== undefined
      ? { mockSuccessRate: Number(env.MOCK_EMAIL_SUCCESS_RATE) }
      : {}),
    ...(env.MOCK_EMAIL_LATENCY_MS !== undefined
      ? { mockLatencyMs: Number(env.MOCK_EMAIL_LATENCY_MS) }
      : {}),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
