import type { NotificationRequestId } from "@notification-system/shared-kernel";

/** `DeliveryAttempt.status` — narrower than shared-kernel's `DeliveryStatus`
 * (no `accepted`: an attempt doesn't exist until it's been made). See
 * data-model.md#notification-delivery-core-domain. */
export const ATTEMPT_STATUSES = ["sent", "failed", "delivered"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export interface DeliveryAttemptProps {
  readonly notificationRequestId: NotificationRequestId;
  readonly attemptNumber: number;
  readonly status: AttemptStatus;
  readonly providerResponse: string | null;
  readonly createdAt: Date;
}

/** One try at delivering a request through one channel — see
 * data-model.md#notification-delivery-core-domain. Composite identity
 * `(notificationRequestId, attemptNumber)`, not a synthetic id. */
export class DeliveryAttempt {
  private constructor(private readonly props: DeliveryAttemptProps) {}

  static record(props: {
    notificationRequestId: NotificationRequestId;
    attemptNumber: number;
    status: AttemptStatus;
    providerResponse?: string | null;
  }): DeliveryAttempt {
    if (props.attemptNumber < 1 || !Number.isInteger(props.attemptNumber)) {
      throw new Error(
        "DeliveryAttempt.attemptNumber must be a positive integer",
      );
    }
    return new DeliveryAttempt({
      ...props,
      providerResponse: props.providerResponse ?? null,
      createdAt: new Date(),
    });
  }

  static reconstitute(props: DeliveryAttemptProps): DeliveryAttempt {
    return new DeliveryAttempt(props);
  }

  get notificationRequestId(): NotificationRequestId {
    return this.props.notificationRequestId;
  }

  get attemptNumber(): number {
    return this.props.attemptNumber;
  }

  get status(): AttemptStatus {
    return this.props.status;
  }

  get providerResponse(): string | null {
    return this.props.providerResponse;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}
