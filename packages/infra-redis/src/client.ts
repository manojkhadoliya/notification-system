import { Redis } from "ioredis";

export interface RedisConnectionConfig {
  readonly url: string;
}

/** Composition roots read `REDIS_URL` from their own env config and pass
 * it in — this package never reads `process.env` itself (same pattern as
 * `infra-postgres`/`infra-kafka`). */
export function createRedis(config: RedisConnectionConfig): Redis {
  return new Redis(config.url);
}
