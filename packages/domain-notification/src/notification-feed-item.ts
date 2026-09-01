import type {
  NotificationRequestId,
  RecipientId,
} from "@notification-system/shared-kernel";

export interface NotificationFeedItemProps {
  readonly id: string;
  readonly recipientId: RecipientId;
  readonly notificationRequestId: NotificationRequestId;
  /** Short rendered preview for the feed list — see
   * data-model.md#notificationfeeditem. */
  readonly summary: string;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

/**
 * The `in_app` channel's only projection — "the feed" a recipient sees,
 * written by `services/worker-inapp` (see
 * messaging.md#in-app-is-structurally-different) instead of calling an
 * external provider. One row per `notificationRequestId`: writing again
 * for the same request (a redelivered `command.in_app` message) is an
 * idempotent upsert, not a new row — see `NotificationFeedRepository.save`'s
 * doc comment.
 */
export class NotificationFeedItem {
  private constructor(private readonly props: NotificationFeedItemProps) {}

  static write(props: {
    id: string;
    recipientId: RecipientId;
    notificationRequestId: NotificationRequestId;
    summary: string;
  }): NotificationFeedItem {
    return new NotificationFeedItem({
      ...props,
      createdAt: new Date(),
      readAt: null,
    });
  }

  static reconstitute(props: NotificationFeedItemProps): NotificationFeedItem {
    return new NotificationFeedItem(props);
  }

  get id(): string {
    return this.props.id;
  }

  get recipientId(): RecipientId {
    return this.props.recipientId;
  }

  get notificationRequestId(): NotificationRequestId {
    return this.props.notificationRequestId;
  }

  get summary(): string {
    return this.props.summary;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get readAt(): Date | null {
    return this.props.readAt;
  }

  /** Marking an already-read item read again is a no-op that keeps the
   * original `readAt` — same "one-way transition" precedent as
   * `ApiKey.revoke`. */
  markRead(at: Date = new Date()): NotificationFeedItem {
    if (this.props.readAt !== null) {
      return this;
    }
    return new NotificationFeedItem({ ...this.props, readAt: at });
  }
}
