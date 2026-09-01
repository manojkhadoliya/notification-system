export interface SchedulerConfig {
  readonly databaseUrl: string;
  readonly kafkaBrokers: string[];
  readonly kafkaClientId: string;
  /** This shard's bucket, `0 <= bucket < bucketCount` — see
   * ADR 0011#poller-sharding. A single instance (`bucket=0`,
   * `bucketCount=1`, the default) claims every due row; running more
   * than one instance means giving each a distinct `bucket` over the
   * same `bucketCount`, so every `due_minute` is owned by exactly one
   * shard. */
  readonly bucket: number;
  readonly bucketCount: number;
  /** Max rows one `pollOnce()` claims — bounds how much work a single
   * poll cycle takes on, not a total/lifetime cap. */
  readonly claimLimit: number;
  readonly pollIntervalMs: number;
}

/** Takes an env object rather than reading `process.env` internally so
 * it's a pure, unit-testable function — same pattern as every other
 * `services/*` `config.ts` this session. */
export function loadConfig(env: NodeJS.ProcessEnv): SchedulerConfig {
  const bucket = Number(env.SCHEDULER_BUCKET ?? 0);
  const bucketCount = Number(env.SCHEDULER_BUCKET_COUNT ?? 1);
  if (
    !Number.isInteger(bucket) ||
    !Number.isInteger(bucketCount) ||
    bucketCount < 1 ||
    bucket < 0 ||
    bucket >= bucketCount
  ) {
    throw new Error(
      `Invalid scheduler shard config: SCHEDULER_BUCKET=${String(env.SCHEDULER_BUCKET)}, ` +
        `SCHEDULER_BUCKET_COUNT=${String(env.SCHEDULER_BUCKET_COUNT)} — ` +
        "bucket and bucketCount must be integers with 0 <= bucket < bucketCount.",
    );
  }

  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    kafkaBrokers: requireEnv(env, "KAFKA_BROKERS").split(","),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? "scheduler",
    bucket,
    bucketCount,
    claimLimit: Number(env.SCHEDULER_CLAIM_LIMIT ?? 100),
    pollIntervalMs: Number(env.SCHEDULER_POLL_INTERVAL_MS ?? 5_000),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
