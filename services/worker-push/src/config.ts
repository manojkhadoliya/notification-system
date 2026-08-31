export type GatewayConfig =
  | {
      readonly kind: "mock";
      readonly successRate?: number;
      readonly latencyMs?: number;
    }
  | {
      readonly kind: "fcm";
      readonly projectId: string;
      readonly clientEmail: string;
      readonly privateKey: string;
    };

export interface WorkerPushConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly kafkaBrokers: string[];
  readonly kafkaClientId: string;
  readonly kafkaGroupId: string;
  readonly gateway: GatewayConfig;
}

/** Takes an env object rather than reading `process.env` internally so
 * it's a pure, unit-testable function — same pattern as
 * `services/worker-sms`'s `config.ts`; only `index.ts` calls this with
 * the real `process.env`.
 *
 * `PUSH_PROVIDER=fcm` requires `FCM_PROJECT_ID`/`FCM_CLIENT_EMAIL`/
 * `FCM_PRIVATE_KEY`; anything else (including unset) defaults to the
 * mock gateway — see `providers-push/README.md`. `FCM_PRIVATE_KEY` is
 * read with literal `\n` sequences un-escaped to real newlines — how a
 * PEM key ends up in most env-var stores (the service-account JSON's
 * `private_key` field is itself `\n`-escaped once already). */
export function loadConfig(env: NodeJS.ProcessEnv): WorkerPushConfig {
  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    redisUrl: requireEnv(env, "REDIS_URL"),
    kafkaBrokers: requireEnv(env, "KAFKA_BROKERS").split(","),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? "worker-push",
    kafkaGroupId: env.KAFKA_GROUP_ID ?? "worker-push",
    gateway: loadGatewayConfig(env),
  };
}

function loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  if (env.PUSH_PROVIDER === "fcm") {
    return {
      kind: "fcm",
      projectId: requireEnv(env, "FCM_PROJECT_ID"),
      clientEmail: requireEnv(env, "FCM_CLIENT_EMAIL"),
      privateKey: requireEnv(env, "FCM_PRIVATE_KEY").replace(/\\n/g, "\n"),
    };
  }
  return {
    kind: "mock",
    ...(env.MOCK_PUSH_SUCCESS_RATE !== undefined
      ? { successRate: Number(env.MOCK_PUSH_SUCCESS_RATE) }
      : {}),
    ...(env.MOCK_PUSH_LATENCY_MS !== undefined
      ? { latencyMs: Number(env.MOCK_PUSH_LATENCY_MS) }
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
