import type {
  BroadcastId,
  ChunkId,
  Priority,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";

/** Work-sized chunking cap — see
 * messaging.md#fan-out--one-event-many-recipients: capped at 200
 * recipients per chunk, sized by *work* (up to 4 channel commands per
 * recipient) rather than raw recipient count. */
export const MAX_RECIPIENTS_PER_CHUNK = 200;

/** A broadcast's audience descriptor — Door 2 only, see
 * messaging.md#broadcast-is-door-2-only. `audienceDescriptor` is opaque to
 * `domain-notification`: resolving it into concrete recipient ids is
 * `services/fanout-expander`'s job (Phase 1, not yet built), using
 * whatever lookup its composition root wires in — the domain layer only
 * carries the descriptor through. */
export interface BroadcastRequest {
  readonly id: BroadcastId;
  readonly tenantId: TenantId;
  readonly audienceDescriptor: Record<string, unknown>;
  readonly notificationType: string;
  readonly payload: Record<string, unknown>;
  readonly priority: Priority;
  readonly createdAt: Date;
}

/** A work-sized group of recipients `services/fanout-expander` splits a
 * `BroadcastRequest` into before expanding each into an individual
 * per-recipient event — see messaging.md#fan-out--one-event-many-recipients. */
export interface Chunk {
  readonly id: ChunkId;
  readonly broadcastId: BroadcastId;
  readonly recipientIds: readonly RecipientId[];
}

export function assertValidChunkSize(
  recipientIds: readonly RecipientId[],
): void {
  if (recipientIds.length === 0) {
    throw new Error("A Chunk must contain at least one recipient");
  }
  if (recipientIds.length > MAX_RECIPIENTS_PER_CHUNK) {
    throw new Error(
      `A Chunk cannot exceed ${MAX_RECIPIENTS_PER_CHUNK} recipients (got ${recipientIds.length})`,
    );
  }
}

/**
 * Splits a resolved audience into `Chunk`s of at most
 * `MAX_RECIPIENTS_PER_CHUNK` — the pure half of
 * `services/fanout-expander`'s stage 1 (see
 * messaging.md#fan-out--one-event-many-recipients). `makeChunkId` is a
 * constructor seam (rather than this function calling `randomUUID()`
 * itself) so chunk ids are deterministic in tests, same pattern as
 * `RouterService`'s `now`/`jitter` seams.
 *
 * An empty `recipientIds` produces zero chunks, not an error — an
 * audience descriptor that resolves to nobody is a legitimate (if
 * unusual) outcome, not a caller mistake `assertValidChunkSize` should
 * reject.
 */
export function splitIntoChunks(
  broadcastId: BroadcastId,
  recipientIds: readonly RecipientId[],
  makeChunkId: () => ChunkId,
): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = 0; i < recipientIds.length; i += MAX_RECIPIENTS_PER_CHUNK) {
    const slice = recipientIds.slice(i, i + MAX_RECIPIENTS_PER_CHUNK);
    chunks.push({ id: makeChunkId(), broadcastId, recipientIds: slice });
  }
  return chunks;
}

/**
 * What's actually published on `events.broadcast.chunks` — a `Chunk`
 * (this chunk's own identity + its recipients) combined with everything
 * from the originating `BroadcastRequest` that `services/fanout-expander`'s
 * stage 2 needs to expand each recipient into a full `NotificationEvent`,
 * without a second lookup back to the original request. Same
 * self-contained-payload principle
 * messaging.md#self-contained-command-payload applies to `command.*` —
 * carrying the context forward once, rather than re-deriving or
 * re-fetching it downstream.
 *
 * Deliberately has no `channel`/`templateVersionId` fields:
 * `BroadcastRequest` doesn't carry either (see its own doc comment) — a
 * broadcast always auto-picks a channel per recipient and never renders
 * a template, a real Phase 1 limitation, not an oversight here.
 */
export interface BroadcastChunk {
  readonly chunkId: ChunkId;
  readonly broadcastId: BroadcastId;
  readonly recipientIds: readonly RecipientId[];
  readonly tenantId: TenantId;
  readonly notificationType: string;
  readonly payload: Record<string, unknown>;
  readonly priority: Priority;
}
