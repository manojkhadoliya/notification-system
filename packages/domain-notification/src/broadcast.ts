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
