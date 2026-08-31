export interface TokenBucketState {
  readonly tokens: number;
  readonly updatedAtMs: number;
}

export interface TokenBucketPolicy {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface TokenBucketResult {
  readonly allowed: boolean;
  readonly state: TokenBucketState;
}

/**
 * Pure refill-then-consume-one-token step — no I/O, so it's unit-testable
 * without a live Redis (see `token-bucket.test.ts`). `TOKEN_BUCKET_LUA`
 * below implements the exact same logic atomically server-side; this
 * function is that logic's unit-tested reference, not something
 * `RedisRateLimiter` calls at runtime — Redis has to do the read-refill-
 * write itself, in one round trip, or concurrent callers could race
 * between JS reading the old state and writing the new one.
 *
 * `previous === null` means "never seen this key" -> starts full, per
 * standard token-bucket semantics (a fresh tenant/channel isn't
 * throttled from its first request). Even on denial, the refilled
 * (fractional) token count is still returned/saved — an elapsed-time
 * credit shouldn't be lost just because this particular call didn't
 * clear the >=1 threshold.
 */
export function stepTokenBucket(
  previous: TokenBucketState | null,
  policy: TokenBucketPolicy,
  nowMs: number,
): TokenBucketResult {
  const prevTokens = previous?.tokens ?? policy.capacity;
  const prevUpdatedAtMs = previous?.updatedAtMs ?? nowMs;
  const elapsedSeconds = Math.max(0, (nowMs - prevUpdatedAtMs) / 1000);
  const refilled = Math.min(
    policy.capacity,
    prevTokens + elapsedSeconds * policy.refillPerSecond,
  );

  if (refilled < 1) {
    return { allowed: false, state: { tokens: refilled, updatedAtMs: nowMs } };
  }
  return { allowed: true, state: { tokens: refilled - 1, updatedAtMs: nowMs } };
}

/**
 * Server-side mirror of `stepTokenBucket`, run via `EVAL` so the
 * read-refill-write is atomic under concurrent callers hitting the same
 * `(tenantId, channel)` key (see `RedisRateLimiter`). `KEYS[1]` is the
 * bucket key (an hgetall'd `{tokens, updatedAtMs}` pair); `ARGV` is
 * `capacity, refillPerSecond, nowMs, ttlSeconds`. Returns `1` (allowed) or
 * `0` (denied) — kept deliberately in lockstep with `stepTokenBucket`;
 * change one, change the other, and re-run `token-bucket.test.ts` as the
 * spec both must satisfy.
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSecond = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local ttlSeconds = tonumber(ARGV[4])

local raw = redis.call("HMGET", key, "tokens", "updatedAtMs")
local tokens = tonumber(raw[1])
local updatedAtMs = tonumber(raw[2])

if tokens == nil then
  tokens = capacity
  updatedAtMs = nowMs
end

local elapsedSeconds = math.max(0, (nowMs - updatedAtMs) / 1000)
local refilled = math.min(capacity, tokens + elapsedSeconds * refillPerSecond)

local allowed = 0
if refilled >= 1 then
  allowed = 1
  refilled = refilled - 1
end

redis.call("HMSET", key, "tokens", tostring(refilled), "updatedAtMs", tostring(nowMs))
redis.call("EXPIRE", key, ttlSeconds)

return allowed
`;
