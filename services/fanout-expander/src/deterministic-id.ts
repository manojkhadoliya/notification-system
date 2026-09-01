import { createHash } from "node:crypto";

/**
 * A deterministic (not random) UUID-*shaped* id derived from `seed` —
 * unlike every other id in this system (always a fresh
 * `crypto.randomUUID()`), this service deliberately derives
 * `chunkId`/`notificationRequestId` from stable inputs
 * (`broadcastId`+chunk index, `chunkId`+`recipientId`) so that a Kafka
 * redelivery of `events.broadcast`/`events.broadcast.chunks` — which
 * *will* happen under normal at-least-once delivery — reproduces the
 * exact same ids rather than minting new ones. That, combined with the
 * dedupe claim every channel worker already takes before calling a
 * provider (see ADR 0010), means a redelivered fan-out message is safe
 * to reprocess: the dedupe claim recognizes the retry and no-ops it,
 * the same as any other redelivered message in this system, rather than
 * sending duplicate notifications. See `FanoutExpanderService`'s doc
 * comment.
 *
 * Not a spec-compliant UUIDv5 (no RFC 4122 namespace/version bit
 * assignment) — just a stable, UUID-*shaped* string so it satisfies
 * Postgres's `@db.Uuid` column type (`DedupeClaim.notificationRequestId`
 * among others). Nothing here needs real UUID semantics beyond "looks
 * like one, and collisions between different seeds are practically
 * impossible" — SHA-256 comfortably provides that.
 */
export function deterministicId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
