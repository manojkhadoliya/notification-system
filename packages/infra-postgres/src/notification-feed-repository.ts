import type {
  PrismaClient,
  NotificationFeedItem as PrismaNotificationFeedItem,
} from "./prisma-client.js";
import type {
  NotificationRequestId,
  RecipientId,
} from "@notification-system/shared-kernel";
import {
  NotificationFeedItem,
  type NotificationFeedRepository,
} from "@notification-system/domain-notification";

function toDomain(row: PrismaNotificationFeedItem): NotificationFeedItem {
  return NotificationFeedItem.reconstitute({
    id: row.id,
    recipientId: row.recipientId as RecipientId,
    notificationRequestId: row.notificationRequestId as NotificationRequestId,
    summary: row.summary,
    createdAt: row.createdAt,
    readAt: row.readAt,
  });
}

export class PostgresNotificationFeedRepository implements NotificationFeedRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(item: NotificationFeedItem): Promise<void> {
    await this.prisma.notificationFeedItem.upsert({
      where: { notificationRequestId: item.notificationRequestId },
      create: {
        id: item.id,
        recipientId: item.recipientId,
        notificationRequestId: item.notificationRequestId,
        summary: item.summary,
        createdAt: item.createdAt,
        readAt: item.readAt,
      },
      // A redelivered write only ever refreshes the summary — `id` and
      // `createdAt` stay pinned to the first write, and `readAt` is never
      // regressed back to null by a redelivery (see markRead's "one-way
      // transition" doc comment; this upsert isn't where reads happen).
      update: {
        summary: item.summary,
      },
    });
  }

  async findByRecipient(
    recipientId: RecipientId,
    options?: { unreadOnly?: boolean },
  ): Promise<NotificationFeedItem[]> {
    const rows = await this.prisma.notificationFeedItem.findMany({
      where: { recipientId, ...(options?.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toDomain);
  }

  async markRead(
    recipientId: RecipientId,
    notificationRequestId: NotificationRequestId,
  ): Promise<void> {
    // updateMany, not update: there's no guarantee a row exists for this
    // (recipientId, notificationRequestId) pair, and update() throws if
    // its `where` doesn't match — a no-op is the correct behavior here
    // (see the port's doc comment), not an error.
    await this.prisma.notificationFeedItem.updateMany({
      where: { recipientId, notificationRequestId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
