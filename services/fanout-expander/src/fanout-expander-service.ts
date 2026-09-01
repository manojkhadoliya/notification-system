import {
  splitIntoChunks,
  type BroadcastChunk,
  type BroadcastRequest,
  type MessageBroker,
} from "@notification-system/domain-notification";
import {
  ChunkId,
  NotificationRequestId,
} from "@notification-system/shared-kernel";
import type { ConsumedMessage } from "@notification-system/infra-kafka";
import {
  EVENTS_BROADCAST_CHUNKS_TOPIC,
  EVENTS_BROADCAST_TOPIC,
} from "@notification-system/infra-kafka";
import type { AudienceResolver } from "./audience-resolver.js";
import { deterministicId } from "./deterministic-id.js";

export interface FanoutExpanderServiceDeps {
  readonly audienceResolver: AudienceResolver;
  readonly messageBroker: MessageBroker;
}

/**
 * Both stages of ADR 0011's fan-out, driven by which topic a message
 * arrived on (same "tell them apart by `message.topic`" pattern
 * `WorkerService` uses for main-vs-retry-tier messages).
 *
 * **Redelivery safety, by construction, not by accident.** Every id this
 * service mints — a chunk's `chunkId`, an expanded recipient's
 * `notificationRequestId` — is `deterministicId`-derived from stable
 * inputs (`broadcastId` + the chunk's position; `chunkId` + `recipientId`)
 * rather than `crypto.randomUUID()`. Combined with
 * `PreferenceAudienceResolver`'s stable (`ORDER BY id`) audience
 * resolution, a Kafka redelivery of either topic — which *will* happen
 * under normal at-least-once delivery — reproduces the exact same chunk
 * boundaries and the exact same per-recipient ids as the original
 * attempt. That means the dedupe claim every channel worker already
 * takes before calling a provider (ADR 0010) recognizes a redelivered
 * fan-out the same way it recognizes any other redelivered message: as
 * "already claimed," not as a reason to send a notification twice.
 *
 * **The one case this doesn't cover:** if the tenant's recipient set
 * actually changes between the original attempt and a redelivery (a
 * recipient added/removed mid-broadcast), stage 1's chunk boundaries can
 * shift, which can change which recipients land in which
 * (deterministically-numbered) chunk. Not solved here — a real gap,
 * documented rather than silently assumed away; see this package's
 * README.
 */
export class FanoutExpanderService {
  constructor(private readonly deps: FanoutExpanderServiceDeps) {}

  async handle(message: ConsumedMessage): Promise<void> {
    if (message.topic === EVENTS_BROADCAST_TOPIC) {
      return this.handleBroadcast(message);
    }
    if (message.topic === EVENTS_BROADCAST_CHUNKS_TOPIC) {
      return this.handleChunk(message);
    }
    console.error(
      `services/fanout-expander: consumed an unexpected topic "${message.topic}", skipping`,
    );
  }

  private async handleBroadcast(message: ConsumedMessage): Promise<void> {
    if (message.value === null) return;
    let request: BroadcastRequest;
    try {
      request = JSON.parse(message.value) as BroadcastRequest;
    } catch (err) {
      console.error(
        "services/fanout-expander: failed to parse a message on events.broadcast, skipping",
        err,
      );
      return;
    }

    let recipientIds;
    try {
      recipientIds = await this.deps.audienceResolver.resolve(
        request.tenantId,
        request.audienceDescriptor,
      );
    } catch (err) {
      // A data problem (an unrecognized audienceDescriptor shape), not a
      // transient one — logged and skipped, not retried forever. Same
      // treatment services/router gives an unresolvable
      // templateVersionId: events.broadcast has no DLQ of its own,
      // same as events.* generally.
      console.error(
        `services/fanout-expander: could not resolve the audience for broadcast ${request.id} — skipping`,
        err,
      );
      return;
    }

    let chunkIndex = 0;
    const chunks = splitIntoChunks(request.id, recipientIds, () =>
      ChunkId(deterministicId(`${request.id}:chunk:${chunkIndex++}`)),
    );

    for (const chunk of chunks) {
      const broadcastChunk: BroadcastChunk = {
        chunkId: chunk.id,
        broadcastId: chunk.broadcastId,
        recipientIds: chunk.recipientIds,
        tenantId: request.tenantId,
        notificationType: request.notificationType,
        payload: request.payload,
        priority: request.priority,
      };
      await this.deps.messageBroker.publishChunk(broadcastChunk);
    }
  }

  private async handleChunk(message: ConsumedMessage): Promise<void> {
    if (message.value === null) return;
    let chunk: BroadcastChunk;
    try {
      chunk = JSON.parse(message.value) as BroadcastChunk;
    } catch (err) {
      console.error(
        "services/fanout-expander: failed to parse a message on events.broadcast.chunks, skipping",
        err,
      );
      return;
    }

    for (const recipientId of chunk.recipientIds) {
      await this.deps.messageBroker.publishEvent({
        notificationRequestId: NotificationRequestId(
          deterministicId(`${chunk.chunkId}:${recipientId}`),
        ),
        tenantId: chunk.tenantId,
        recipientId,
        notificationType: chunk.notificationType,
        // A broadcast never specifies a channel override or a template —
        // BroadcastRequest/BroadcastChunk carry neither field; see
        // BroadcastChunk's own doc comment.
        channel: null,
        templateVersionId: null,
        payloadRef: chunk.payload,
        priority: chunk.priority,
        broadcastId: chunk.broadcastId,
        // No Idempotency-Key concept outside Door 1 — see
        // NotificationEvent.idempotencyKey's doc comment.
        idempotencyKey: null,
      });
    }
  }
}
