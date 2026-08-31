export type GatewayConfig =
  | {
      readonly kind: "mock";
      readonly successRate?: number;
      readonly latencyMs?: number;
    }
  | {
      readonly kind: "twilio";
      readonly accountSid: string;
      readonly authToken: string;
      readonly fromNumber: string;
    };

export interface WorkerSmsConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly kafkaBrokers: string[];
  readonly kafkaClientId: string;
  readonly kafkaGroupId: string;
  readonly gateway: GatewayConfig;
}

/** Takes an env object rather than reading `process.env` internally so
 * it's a pure, unit-testable function — same pattern as
 * `services/api`/`services/router`'s `config.ts`; only `index.ts` calls
 * this with the real `process.env`.
 *
 * `SMS_PROVIDER=twilio` requires `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/
 * `TWILIO_FROM_NUMBER`; anything else (including unset) defaults to the
 * mock gateway — see `providers-sms/README.md`. */
export function loadConfig(env: NodeJS.ProcessEnv): WorkerSmsConfig {
  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    redisUrl: requireEnv(env, "REDIS_URL"),
    kafkaBrokers: requireEnv(env, "KAFKA_BROKERS").split(","),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? "worker-sms",
    kafkaGroupId: env.KAFKA_GROUP_ID ?? "worker-sms",
    gateway: loadGatewayConfig(env),
  };
}

function loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  if (env.SMS_PROVIDER === "twilio") {
    return {
      kind: "twilio",
      accountSid: requireEnv(env, "TWILIO_ACCOUNT_SID"),
      authToken: requireEnv(env, "TWILIO_AUTH_TOKEN"),
      fromNumber: requireEnv(env, "TWILIO_FROM_NUMBER"),
    };
  }
  return {
    kind: "mock",
    ...(env.MOCK_SMS_SUCCESS_RATE !== undefined
      ? { successRate: Number(env.MOCK_SMS_SUCCESS_RATE) }
      : {}),
    ...(env.MOCK_SMS_LATENCY_MS !== undefined
      ? { latencyMs: Number(env.MOCK_SMS_LATENCY_MS) }
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
