import type {
  NotificationRequestId,
  TenantId,
} from "@notification-system/shared-kernel";

/** Recorded the first time an idempotency key is seen — just enough to
 * answer a safe retry without re-deriving the original response. See
 * multi-tenancy.md#idempotency. */
export interface IdempotencyRecord {
  readonly payloadHash: string;
  readonly notificationRequestId: NotificationRequestId;
}

/**
 * `services/api` calls this at `POST /v1/notifications` ingest, keyed by
 * the client-supplied `Idempotency-Key` header, before writing a
 * `NotificationRequest` — see multi-tenancy.md#idempotency:
 * - `find` returns `null` on a key not seen before -> proceed.
 * - Returns a record with a matching `payloadHash` -> safe retry, return
 *   the original result (look it up via `NotificationRepository.findById`
 *   using the returned `notificationRequestId`).
 * - Returns a record with a different `payloadHash` -> 409 Conflict.
 *
 * Implemented by `infra-redis`, TTL'd (e.g. 24h) — the adapter's concern,
 * not this interface's.
 */
export interface IdempotencyStore {
  find(
    tenantId: TenantId,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null>;
  /** Only called after `find` returned `null` and the request was
   * successfully created. Not specified to be atomic with that `find` —
   * two concurrent requests racing the same never-before-seen key can
   * both proceed and both `reserve` (last write wins). Acceptable at this
   * system's scale (see multi-tenancy.md's other documented,
   * not-solved-here races); a caller needing a hard guarantee would claim
   * the key itself first (e.g. via `DedupeRepository`'s pattern), which
   * this port deliberately doesn't do since idempotency and delivery
   * dedupe are different concerns (client-retry protection vs.
   * redelivery protection). */
  reserve(
    tenantId: TenantId,
    idempotencyKey: string,
    record: IdempotencyRecord,
  ): Promise<void>;
}
