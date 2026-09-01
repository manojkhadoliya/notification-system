import type {
  BroadcastId,
  Channel,
  NotificationRequestId,
  Priority,
  RecipientId,
  TemplateVersionId,
  TenantId,
} from "@notification-system/shared-kernel";

export const SCHEDULED_NOTIFICATION_STATUSES = [
  "pending",
  "claimed",
  "emitted",
] as const;
export type ScheduledNotificationStatus =
  (typeof SCHEDULED_NOTIFICATION_STATUSES)[number];

export interface ScheduledNotificationProps {
  readonly id: string;
  /** The *original* `NotificationEvent.notificationRequestId` this row
   * defers — distinct from `id` (this row's own primary key). Preserved
   * so `services/scheduler` can re-emit the same `notificationRequestId`
   * the client was handed at `202 Accepted` time, instead of minting a
   * new one; without it, a deferred (e.g. quiet-hours) notification's
   * status would become permanently unqueryable via
   * `GET /v1/notifications/:id` once re-emitted under a different id. */
  readonly notificationRequestId: NotificationRequestId;
  readonly tenantId: TenantId;
  readonly recipientId: RecipientId;
  readonly notificationType: string;
  readonly channel: Channel | null;
  readonly templateVersionId: TemplateVersionId | null;
  readonly payload: Record<string, unknown>;
  readonly priority: Priority;
  /** Preserved for the same reason as `notificationRequestId` above — a
   * fanout-expanded recipient's event carries a `broadcastId`
   * back-reference (see ADR 0011); if it's deferred by quiet hours, the
   * re-emitted event must still carry it, or the back-reference is lost
   * on every quiet-hours-deferred broadcast recipient. */
  readonly broadcastId: BroadcastId | null;
  /** Same preserve-across-defer reasoning as `notificationRequestId`/
   * `broadcastId` above — the original `NotificationEvent.idempotencyKey`
   * (`null` for anything Door 2 originated), carried through so the
   * re-emitted event's `idempotencyKey` matches what the original event
   * carried, for `NotificationRequest.idempotencyKey`'s sake once
   * `services/projection-notification` creates the row. */
  readonly idempotencyKey: string | null;
  readonly dueAt: Date;
  /** Derived from `dueAt`, not independently settable — see
   * ADR 0011#poller-sharding: the poller shards its claim queries by this
   * value, so it must always agree with `dueAt`. */
  readonly dueMinute: number;
  readonly status: ScheduledNotificationStatus;
  readonly claimedAt: Date | null;
  readonly createdAt: Date;
}

function minutesSinceEpoch(date: Date): number {
  return Math.floor(date.getTime() / 60_000);
}

/**
 * A deferred `NotificationRequest`, held for a quiet-hours window or a
 * future send, keyed by `due_at` — see data-model.md#scheduled_notifications
 * and ADR 0011. `services/scheduler` polls for rows past due and re-emits
 * them onto the event backbone; this entity models the
 * `pending -> claimed -> emitted` lifecycle a poller shard drives via
 * `SELECT ... FOR UPDATE SKIP LOCKED`.
 */
export class ScheduledNotification {
  private constructor(private readonly props: ScheduledNotificationProps) {}

  static schedule(props: {
    id: string;
    notificationRequestId: NotificationRequestId;
    tenantId: TenantId;
    recipientId: RecipientId;
    notificationType: string;
    channel?: Channel | null;
    templateVersionId?: TemplateVersionId | null;
    payload: Record<string, unknown>;
    priority: Priority;
    broadcastId?: BroadcastId | null;
    idempotencyKey?: string | null;
    dueAt: Date;
  }): ScheduledNotification {
    return new ScheduledNotification({
      ...props,
      channel: props.channel ?? null,
      templateVersionId: props.templateVersionId ?? null,
      broadcastId: props.broadcastId ?? null,
      idempotencyKey: props.idempotencyKey ?? null,
      dueMinute: minutesSinceEpoch(props.dueAt),
      status: "pending",
      claimedAt: null,
      createdAt: new Date(),
    });
  }

  static reconstitute(
    props: ScheduledNotificationProps,
  ): ScheduledNotification {
    return new ScheduledNotification(props);
  }

  get id(): string {
    return this.props.id;
  }

  get notificationRequestId(): NotificationRequestId {
    return this.props.notificationRequestId;
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get recipientId(): RecipientId {
    return this.props.recipientId;
  }

  get notificationType(): string {
    return this.props.notificationType;
  }

  get channel(): Channel | null {
    return this.props.channel;
  }

  get templateVersionId(): TemplateVersionId | null {
    return this.props.templateVersionId;
  }

  get payload(): Record<string, unknown> {
    return this.props.payload;
  }

  get priority(): Priority {
    return this.props.priority;
  }

  get broadcastId(): BroadcastId | null {
    return this.props.broadcastId;
  }

  get idempotencyKey(): string | null {
    return this.props.idempotencyKey;
  }

  get dueAt(): Date {
    return this.props.dueAt;
  }

  get dueMinute(): number {
    return this.props.dueMinute;
  }

  get status(): ScheduledNotificationStatus {
    return this.props.status;
  }

  get claimedAt(): Date | null {
    return this.props.claimedAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  isDue(now: Date): boolean {
    return this.props.status === "pending" && this.props.dueAt <= now;
  }

  /** The row-level lock (`SELECT ... FOR UPDATE SKIP LOCKED`) is what
   * actually prevents two poller shards claiming the same row
   * concurrently — this method is the in-memory mirror of that guard, so
   * a caller that already holds the lock still can't misuse the entity
   * (e.g. claim something already claimed) without it being visible here
   * too. */
  claim(at: Date = new Date()): ScheduledNotification {
    if (this.props.status !== "pending") {
      throw new Error(
        `Cannot claim a ScheduledNotification in status "${this.props.status}"`,
      );
    }
    return new ScheduledNotification({
      ...this.props,
      status: "claimed",
      claimedAt: at,
    });
  }

  /** Marks this row emitted after the poller has successfully re-produced
   * it onto the event backbone. Must be claimed first — an unclaimed row
   * being marked emitted would mean two shards both thought they owned
   * it, or the poller skipped the claim step. */
  markEmitted(): ScheduledNotification {
    if (this.props.status !== "claimed") {
      throw new Error(
        `Cannot emit a ScheduledNotification in status "${this.props.status}" — it must be claimed first`,
      );
    }
    return new ScheduledNotification({ ...this.props, status: "emitted" });
  }
}
