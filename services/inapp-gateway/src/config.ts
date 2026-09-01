export interface InappGatewayConfig {
  readonly port: number;
  readonly host: string;
  readonly redisUrl: string;
}

/** Takes an env object rather than reading `process.env` internally so
 * it's a pure, unit-testable function — same pattern as every other
 * `services/*` `config.ts` this session. Defaults to port 3001 (not
 * `services/api`'s 3000) purely so both can be started locally without a
 * port clash; in any real deployment each runs in its own container with
 * its own env, same as `services/api`'s own PORT/HOST. No Kafka/Postgres
 * vars — this service has no Kafka consumer-group membership and no
 * domain repository ports at all (see ADR 0012 and this package's
 * README). */
export function loadConfig(env: NodeJS.ProcessEnv): InappGatewayConfig {
  return {
    port: Number(env.PORT ?? 3001),
    host: env.HOST ?? "0.0.0.0",
    redisUrl: requireEnv(env, "REDIS_URL"),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
