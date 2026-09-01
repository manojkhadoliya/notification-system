import type {
  BroadcastId,
  Channel,
  NotificationRequestId,
  Priority,
  RecipientId,
  TemplateVersionId,
  TenantId,
} from "@notification-system/shared-kernel";
import type { BroadcastChunk, BroadcastRequest } from "./broadcast.js";
import type { ChannelCommand } from "./channel-command.js";
import type { DedupeClaim } from "./dedupe-claim.js";
import type { DeliveryAttempt } from "./delivery-attempt.js";
import type { NotificationFeedItem } from "./notification-feed-item.js";
import type { NotificationRequest } from "./notification-request.js";
import type { ScheduledNotification } from "./scheduled-notification.js";

/** The pre-router event shape produced onto `events.*` by either door —
 * see messaging.md#two-doors-onto-one-backbone. Carries payload **by
 * reference** (ids + template variable keys), not rendered content — see
 * messaging.md#self-contained-command-payload. */
export interface NotificationEvent {
  readonly notificationRequestId: NotificationRequestId;
  readonly tenantId: TenantId;
  readonly recipientId: RecipientId;
  readonly notificationType: string;
  /** An explicit override is honored as *requested*, still checked
   * against opt-out — see messaging.md#router. `null` means "let the
   * router pick from the recipient's opted-in channels." */
  readonly channel: Channel | null;
  readonly templateVersionId: TemplateVersionId | null;
  readonly payloadRef: Record<string, unknown>;
  readonly priority: Priority;
  readonly broadcastId: BroadcastId | null;
  /** Door 1's `Idempotency-Key` header, carried through for
   * `NotificationRequest.idempotencyKey` (data-model.md: stored for
   * record-keeping — the actual dedup already happened at ingest, via
   * `IdempotencyStore`, before this event was ever produced). `null` for
   * anything Door 2 originates (internal services, and
   * `services/fanout-expander`'s per-recipient expansion) — there is no
   * `Idempotency-Key` concept for an internally-originated fact; see
   * `messaging.md#two-doors-onto-one-backbone`. */
  readonly idempotencyKey: string | null;
}

/** Published to `delivery-status`, consumed only by
 * `services/projection-notification` — see
 * messaging.md#delivery-status-has-one-writer and
 * ADR 0010#single-writer-status. A discriminated union, not one flat
 * shape: `"accepted"` is the fact that *creates*
 * `services/projection-notification`'s `NotificationRequest` row (the
 * router is the only place that has every field the row needs — resolved
 * `channel`, rendered `payload` — all at once, right when it publishes
 * this), so it carries everything `NotificationRequest.accept()` needs.
 * `"sent"`/`"delivered"`/`"failed"` only ever *advance* a row that
 * already exists, so they carry nothing beyond which request and which
 * attempt. */
export type DeliveryStatusEvent =
  | {
      readonly notificationRequestId: NotificationRequestId;
      readonly status: "accepted";
      readonly attemptNumber: number;
      readonly occurredAt: Date;
      readonly tenantId: TenantId;
      readonly recipientId: RecipientId;
      readonly notificationType: string;
      readonly idempotencyKey: string | null;
      /** The router's *resolved* channel — never null here, unlike
       * `NotificationEvent.channel`: by the time "accepted" is
       * published, routing has already happened. */
      readonly channel: Channel;
      readonly broadcastId: BroadcastId | null;
      /** The *rendered* payload, as published on `command.*` — see
       * `data-model.md`'s `NotificationRequest.payload` and
       * messaging.md#self-contained-command-payload. Not the same value
       * as `NotificationEvent.payloadRef`. */
      readonly payload: Record<string, unknown>;
    }
  | {
      readonly notificationRequestId: NotificationRequestId;
      readonly status: "sent" | "delivered" | "failed";
      readonly attemptNumber: number;
      readonly occurredAt: Date;
    };

/**
 * Publish an event/command for async dispatch — the router and workers
 * consume through this port too (see domain-model.md#notification-delivery-core-domain).
 * Implemented by `infra-kafka`; topic names/partitioning are the
 * adapter's concern, not this interface's — see messaging.md#topic-layout.
 */
export interface MessageBroker {
  /** Door 1/Door 2 -> `events.{critical|standard|bulk}`. */
  publishEvent(event: NotificationEvent): Promise<void>;
  /** `services/router` -> `command.{channel}`. */
  publishCommand(command: ChannelCommand): Promise<void>;
  /** A worker's failed attempt -> that channel's next retry-tier topic.
   * `delayMs` comes from `RetryPolicy.delayBeforeAttempt`. */
  scheduleRetry(command: ChannelCommand, delayMs: number): Promise<void>;
  /** Attempts exhausted (`RetryPolicy.isExhausted`) -> that channel's DLQ. */
  publishToDlq(command: ChannelCommand, reason: string): Promise<void>;
  publishDeliveryStatus(event: DeliveryStatusEvent): Promise<void>;
  /** Door 2 (the producer library) -> `events.broadcast`, keyed by
   * `broadcastId` — see messaging.md#broadcast-is-door-2-only. */
  publishBroadcast(request: BroadcastRequest): Promise<void>;
  /** `services/fanout-expander`'s stage 1 -> `events.broadcast.chunks`,
   * keyed by `chunkId` — a documented exception to the `recipientId`
   * keying every other topic uses, since a chunk carries many recipients
   * and can't honestly be keyed by any single one of them. See
   * ADR 0011. */
  publishChunk(chunk: BroadcastChunk): Promise<void>;
}

/** Persist/query requests and attempts — read model only as of ADR 0009;
 * nothing on the delivery path reads through it (see
 * domain-model.md#notification-delivery-core-domain). Only
 * `services/projection-notification` and `GET /v1/notifications/:id`
 * actually use this port. */
export interface NotificationRepository {
  findById(id: NotificationRequestId): Promise<NotificationRequest | null>;
  save(request: NotificationRequest): Promise<void>;
  /** `GET /v1/notifications/:id` reads both `NotificationRequest` and its
   * `DeliveryAttempt` history together (see
   * data-model.md#notification-delivery-core-domain) — added here rather
   * than a separate port because both are the same read-model projection,
   * written by the same single writer (`services/projection-notification`
   * for the request; each channel worker for its own attempts). */
  findAttempts(id: NotificationRequestId): Promise<DeliveryAttempt[]>;
  saveAttempt(attempt: DeliveryAttempt): Promise<void>;
}

/** Claim a `DedupeClaim` before a provider call — see ADR 0010. */
export interface DedupeRepository {
  /** `true` if this call took the claim (first time seeing this key);
   * `false` if it was already claimed. Never throws for "already
   * claimed" — that's the expected, common outcome on redelivery, not an
   * error. */
  tryClaim(claim: DedupeClaim): Promise<boolean>;
}

/** Write/claim `ScheduledNotification` rows — see
 * data-model.md#scheduled_notifications and ADR 0011. */
export interface ScheduledNotificationRepository {
  save(notification: ScheduledNotification): Promise<void>;
  /** `services/scheduler`'s poller shard claim — `SELECT ... FOR UPDATE
   * SKIP LOCKED` scoped to one `(dueMinute, bucket)` shard, per
   * ADR 0011#poller-sharding. Returns the rows this call claimed (already
   * transitioned to `"claimed"`), never a row another shard is holding. */
  claimDue(params: {
    upTo: Date;
    dueMinuteBucket: number;
    bucketCount: number;
    limit: number;
  }): Promise<ScheduledNotification[]>;
}

/** Write/read `NotificationFeedItem` rows — the `in_app` channel's only
 * projection, written by `services/worker-inapp` (see
 * messaging.md#in-app-is-structurally-different) and read by
 * `GET /v1/feed/:recipientId`. */
export interface NotificationFeedRepository {
  /** Upsert keyed by `notificationRequestId` — a redelivered
   * `command.in_app` message (a retry, or a Kafka at-least-once
   * redelivery) writes the same logical feed item again, not a
   * duplicate row. `services/worker-inapp` calls this on every attempt,
   * not just the first, so this idempotency is the port's contract, not
   * an optional adapter nicety. */
  save(item: NotificationFeedItem): Promise<void>;
  /** "The feed" — most recent first. `unreadOnly` filters to
   * `readAt === null`. */
  findByRecipient(
    recipientId: RecipientId,
    options?: { unreadOnly?: boolean },
  ): Promise<NotificationFeedItem[]>;
  /** `POST /v1/feed/:recipientId/:notificationRequestId/read` — a no-op
   * if no matching row exists (nothing to mark read) or it's already
   * read (see `NotificationFeedItem.markRead`'s doc comment). */
  markRead(
    recipientId: RecipientId,
    notificationRequestId: NotificationRequestId,
  ): Promise<void>;
}
