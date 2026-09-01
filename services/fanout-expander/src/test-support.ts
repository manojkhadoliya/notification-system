import type {
  BroadcastChunk,
  BroadcastRequest,
  MessageBroker,
  NotificationEvent,
} from "@notification-system/domain-notification";
import type { RecipientId, TenantId } from "@notification-system/shared-kernel";
import { BroadcastId } from "@notification-system/shared-kernel";
import type { AudienceResolver } from "./audience-resolver.js";

export class FakeAudienceResolver implements AudienceResolver {
  private readonly recipientIdsByTenant = new Map<string, RecipientId[]>();
  /** Set to make `resolve` reject for a given tenantId — exercises
   * `FanoutExpanderService`'s "unresolvable audience" handling without
   * needing a real unsupported descriptor. */
  readonly failFor = new Set<string>();

  seed(tenantId: TenantId, recipientIds: RecipientId[]): void {
    this.recipientIdsByTenant.set(tenantId, recipientIds);
  }

  async resolve(tenantId: TenantId): Promise<RecipientId[]> {
    if (this.failFor.has(tenantId)) {
      throw new Error(`simulated unresolvable audience for tenant ${tenantId}`);
    }
    return this.recipientIdsByTenant.get(tenantId) ?? [];
  }
}

export class FakeMessageBroker implements MessageBroker {
  readonly publishedEvents: NotificationEvent[] = [];
  readonly publishedChunks: BroadcastChunk[] = [];
  /** Set a chunkId here to make `publishChunk` throw for that one chunk —
   * exercises error propagation without a real broker failure. */
  readonly failChunkIds = new Set<string>();

  async publishEvent(event: NotificationEvent): Promise<void> {
    this.publishedEvents.push(event);
  }

  async publishChunk(chunk: BroadcastChunk): Promise<void> {
    if (this.failChunkIds.has(chunk.chunkId)) {
      throw new Error(`simulated publish failure for chunk ${chunk.chunkId}`);
    }
    this.publishedChunks.push(chunk);
  }

  async publishBroadcast(): Promise<void> {
    // Not exercised by services/fanout-expander — it's Door 2's
    // producer library that publishes onto events.broadcast in the
    // first place; this service only ever consumes it.
  }

  async publishCommand(): Promise<void> {
    // Not exercised by services/fanout-expander — that's services/router's job.
  }

  async scheduleRetry(): Promise<void> {
    // Not exercised by services/fanout-expander — that's the channel workers' job.
  }

  async publishToDlq(): Promise<void> {
    // Not exercised by services/fanout-expander — see scheduleRetry's comment above.
  }

  async publishDeliveryStatus(): Promise<void> {
    // Not exercised by services/fanout-expander — that's services/router's job.
  }
}

const DEFAULT_BROADCAST_ID = BroadcastId(
  "11111111-1111-1111-1111-111111111111",
);

/** Convenience for tests: a minimal, valid `BroadcastRequest`. */
export function makeBroadcastRequest(
  tenantId: TenantId,
  overrides: Partial<BroadcastRequest> = {},
): BroadcastRequest {
  return {
    id: DEFAULT_BROADCAST_ID,
    tenantId,
    audienceDescriptor: { kind: "all_recipients" },
    notificationType: "digest",
    payload: { message: "hello" },
    priority: "standard",
    createdAt: new Date(),
    ...overrides,
  };
}
