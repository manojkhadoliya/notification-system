import type {
  DeliveryAttempt,
  NotificationRepository,
  NotificationRequest,
} from "@notification-system/domain-notification";
import type { NotificationRequestId } from "@notification-system/shared-kernel";

export class FakeNotificationRepository implements NotificationRepository {
  private readonly rows = new Map<string, NotificationRequest>();
  readonly savedHistory: NotificationRequest[] = [];

  async findById(
    id: NotificationRequestId,
  ): Promise<NotificationRequest | null> {
    return this.rows.get(id) ?? null;
  }

  async save(request: NotificationRequest): Promise<void> {
    this.rows.set(request.id, request);
    this.savedHistory.push(request);
  }

  async findAttempts(): Promise<DeliveryAttempt[]> {
    // Not exercised by services/projection-notification — each channel
    // worker writes its own DeliveryAttempt rows directly; this port
    // method is GET /v1/notifications/:id's, not this service's.
    return [];
  }

  async saveAttempt(): Promise<void> {
    // Not exercised by services/projection-notification — see
    // findAttempts's comment above.
  }
}
