import {
  isValidDeliveryStatusTransition,
  type BroadcastId,
  type Channel,
  type DeliveryStatus,
  type NotificationRequestId,
  type RecipientId,
  type TenantId,
} from "@notification-system/shared-kernel";

export interface NotificationRequestProps {
  readonly id: NotificationRequestId;
  readonly tenantId: TenantId;
  readonly recipientId: RecipientId;
  readonly notificationType: string;
  readonly idempotencyKey: string;
  readonly channel: Channel;
  readonly broadcastId: BroadcastId | null;
  /** Rendered content, as published on `command.*` — see
   * messaging.md#self-contained-command-payload. `unknown` here because
   * the domain layer doesn't interpret payload shape, only carries it. */
  readonly payload: Record<string, unknown>;
  readonly status: DeliveryStatus;
  readonly createdAt: Date;
}

/**
 * A tenant's request to notify one recipient — see
 * data-model.md#notification-delivery-core-domain. This is the read-model
 * projection's shape (Postgres for Phase 1 — see ADR 0003 revised); Kafka,
 * not this entity, is the write-side log of record (ADR 0008).
 *
 * `status` is written **only** by `services/projection-notification`, in
 * strict order (`accepted -> sent -> delivered`, `failed` from either) —
 * see ADR 0010#single-writer-status. `advanceStatus` is this entity
 * enforcing that invariant itself rather than trusting every caller to
 * check `isValidDeliveryStatusTransition` before constructing a new row.
 */
export class NotificationRequest {
  private constructor(private readonly props: NotificationRequestProps) {}

  static accept(props: {
    id: NotificationRequestId;
    tenantId: TenantId;
    recipientId: RecipientId;
    notificationType: string;
    idempotencyKey: string;
    channel: Channel;
    broadcastId?: BroadcastId | null;
    payload: Record<string, unknown>;
  }): NotificationRequest {
    return new NotificationRequest({
      ...props,
      broadcastId: props.broadcastId ?? null,
      status: "accepted",
      createdAt: new Date(),
    });
  }

  static reconstitute(props: NotificationRequestProps): NotificationRequest {
    return new NotificationRequest(props);
  }

  get id(): NotificationRequestId {
    return this.props.id;
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

  get idempotencyKey(): string {
    return this.props.idempotencyKey;
  }

  get channel(): Channel {
    return this.props.channel;
  }

  get broadcastId(): BroadcastId | null {
    return this.props.broadcastId;
  }

  get payload(): Record<string, unknown> {
    return this.props.payload;
  }

  get status(): DeliveryStatus {
    return this.props.status;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  /**
   * Returns a new `NotificationRequest` with `status` advanced to `to`, or
   * `null` if `to` is not a valid transition from the current status — an
   * out-of-order or regressive delivery-status event (a redelivered
   * `sent` arriving after `delivered` already landed, say) should be
   * discarded by the caller, not applied. Returning `null` rather than
   * throwing keeps that a normal, expected branch for
   * `services/projection-notification` — see
   * ADR 0010#single-writer-status.
   */
  advanceStatus(to: DeliveryStatus): NotificationRequest | null {
    if (!isValidDeliveryStatusTransition(this.props.status, to)) {
      return null;
    }
    return new NotificationRequest({ ...this.props, status: to });
  }
}
