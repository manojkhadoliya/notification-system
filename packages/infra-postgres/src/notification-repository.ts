import {
  Prisma,
  type PrismaClient,
  type NotificationRequest as PrismaNotificationRequest,
  type DeliveryAttempt as PrismaDeliveryAttempt,
} from "./prisma-client.js";
import type {
  BroadcastId,
  Channel,
  DeliveryStatus,
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import {
  DeliveryAttempt,
  NotificationRequest,
  type AttemptStatus,
  type NotificationRepository,
} from "@notification-system/domain-notification";

function requestToDomain(row: PrismaNotificationRequest): NotificationRequest {
  return NotificationRequest.reconstitute({
    id: row.id as NotificationRequestId,
    tenantId: row.tenantId as TenantId,
    recipientId: row.recipientId as RecipientId,
    notificationType: row.notificationType,
    idempotencyKey: row.idempotencyKey,
    channel: row.channel as Channel,
    broadcastId: row.broadcastId as BroadcastId | null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status as DeliveryStatus,
    createdAt: row.createdAt,
  });
}

function attemptToDomain(row: PrismaDeliveryAttempt): DeliveryAttempt {
  return DeliveryAttempt.reconstitute({
    notificationRequestId: row.notificationRequestId as NotificationRequestId,
    attemptNumber: row.attemptNumber,
    // AttemptStatus (sent|failed|delivered) is a strict subset of the
    // Postgres DeliveryStatus enum this column reuses (no "accepted") —
    // see schema.prisma's DeliveryAttempt model comment. A row with
    // status "accepted" would only get here from data written outside
    // this adapter's own saveAttempt, which never writes that value.
    status: row.status as AttemptStatus,
    providerResponse: row.providerResponse,
    createdAt: row.createdAt,
  });
}

export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(
    id: NotificationRequestId,
  ): Promise<NotificationRequest | null> {
    const row = await this.prisma.notificationRequest.findUnique({
      where: { id },
    });
    return row === null ? null : requestToDomain(row);
  }

  async save(request: NotificationRequest): Promise<void> {
    await this.prisma.notificationRequest.upsert({
      where: { id: request.id },
      create: {
        id: request.id,
        tenantId: request.tenantId,
        recipientId: request.recipientId,
        notificationType: request.notificationType,
        idempotencyKey: request.idempotencyKey,
        channel: request.channel,
        broadcastId: request.broadcastId,
        payload: request.payload as Prisma.InputJsonValue,
        status: request.status,
        createdAt: request.createdAt,
      },
      // Only `status` can legitimately change after creation (see
      // NotificationRequest.advanceStatus) — every other field is set
      // once, at ingest.
      update: {
        status: request.status,
      },
    });
  }

  async findAttempts(id: NotificationRequestId): Promise<DeliveryAttempt[]> {
    const rows = await this.prisma.deliveryAttempt.findMany({
      where: { notificationRequestId: id },
      orderBy: { attemptNumber: "asc" },
    });
    return rows.map(attemptToDomain);
  }

  /**
   * `DeliveryAttempt.notificationRequestId` is a real FK to
   * `NotificationRequest.id` — but the row it points at is written by a
   * *different* consumer (`services/projection-notification`, off the
   * `delivery-status` topic's "accepted" event) than the one calling
   * this method (`services/worker-*`, off `command.{channel}`). Kafka
   * gives no cross-topic ordering guarantee, so a worker that's faster
   * than projection-notification — confirmed happening in local runs,
   * not hypothetical, see docs/local-development.md — can get here
   * before the parent row exists, and the upsert fails with Prisma's
   * P2003. This is retried a few times with a short delay rather than
   * fixed by publish-order alone (`services/router`'s `dispatch()`
   * already publishes "accepted" before the command, which narrows the
   * window but can't close it — nothing enforces that
   * projection-notification wins the race even when it goes first).
   * A P2003 that outlives every retry is a real bug (a genuinely
   * missing/wrong `notificationRequestId`), not a race, so it's
   * rethrown rather than swallowed.
   */
  async saveAttempt(attempt: DeliveryAttempt): Promise<void> {
    const maxAttempts = 5;
    const baseDelayMs = 100;
    for (let i = 1; i <= maxAttempts; i++) {
      try {
        await this.prisma.deliveryAttempt.upsert({
          where: {
            notificationRequestId_attemptNumber: {
              notificationRequestId: attempt.notificationRequestId,
              attemptNumber: attempt.attemptNumber,
            },
          },
          create: {
            notificationRequestId: attempt.notificationRequestId,
            attemptNumber: attempt.attemptNumber,
            status: attempt.status,
            providerResponse: attempt.providerResponse,
            createdAt: attempt.createdAt,
          },
          update: {
            status: attempt.status,
            providerResponse: attempt.providerResponse,
          },
        });
        return;
      } catch (err) {
        const isMissingParent =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2003";
        if (!isMissingParent || i === maxAttempts) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * i));
      }
    }
  }
}
