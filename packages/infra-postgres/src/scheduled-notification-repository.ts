import { Prisma, type PrismaClient } from "./prisma-client.js";
import type {
  Channel,
  Priority,
  RecipientId,
  TemplateVersionId,
  TenantId,
} from "@notification-system/shared-kernel";
import {
  ScheduledNotification,
  type ScheduledNotificationRepository,
  type ScheduledNotificationStatus,
} from "@notification-system/domain-notification";

/** Shape of one row returned by the raw claim query below — raw queries
 * bypass Prisma's generated model types entirely, so this is hand-written
 * to match `schema.prisma`'s `scheduled_notifications` columns. */
interface ScheduledNotificationRow {
  id: string;
  tenant_id: string;
  recipient_id: string;
  notification_type: string;
  channel: Channel | null;
  template_version_id: string | null;
  payload: unknown;
  priority: Priority;
  due_at: Date;
  due_minute: number;
  status: ScheduledNotificationStatus;
  claimed_at: Date | null;
  created_at: Date;
}

function rowToDomain(row: ScheduledNotificationRow): ScheduledNotification {
  return ScheduledNotification.reconstitute({
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    recipientId: row.recipient_id as RecipientId,
    notificationType: row.notification_type,
    channel: row.channel,
    templateVersionId: row.template_version_id as TemplateVersionId | null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    priority: row.priority,
    dueAt: row.due_at,
    dueMinute: row.due_minute,
    status: row.status,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
  });
}

export class PostgresScheduledNotificationRepository implements ScheduledNotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(notification: ScheduledNotification): Promise<void> {
    await this.prisma.scheduledNotification.upsert({
      where: { id: notification.id },
      create: {
        id: notification.id,
        tenantId: notification.tenantId,
        recipientId: notification.recipientId,
        notificationType: notification.notificationType,
        channel: notification.channel,
        templateVersionId: notification.templateVersionId,
        payload: notification.payload as Prisma.InputJsonValue,
        priority: notification.priority,
        dueAt: notification.dueAt,
        dueMinute: notification.dueMinute,
        status: notification.status,
        claimedAt: notification.claimedAt,
        createdAt: notification.createdAt,
      },
      update: {
        status: notification.status,
        claimedAt: notification.claimedAt,
      },
    });
  }

  /**
   * `SELECT ... FOR UPDATE SKIP LOCKED`, scoped to one `(dueMinute,
   * bucket)` shard — see ADR 0011#poller-sharding. Prisma's query builder
   * has no row-locking API, so this is raw SQL (parameterized via
   * `Prisma.sql`, not string interpolation — safe from injection) inside
   * an explicit transaction so the lock is held for the claiming UPDATE,
   * not just the SELECT.
   */
  async claimDue(params: {
    upTo: Date;
    dueMinuteBucket: number;
    bucketCount: number;
    limit: number;
  }): Promise<ScheduledNotification[]> {
    const { upTo, dueMinuteBucket, bucketCount, limit } = params;

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ScheduledNotificationRow[]>(Prisma.sql`
        WITH candidates AS (
          SELECT id FROM scheduled_notifications
          WHERE status = 'pending'
            AND due_at <= ${upTo}
            AND due_minute % ${bucketCount} = ${dueMinuteBucket}
          ORDER BY due_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE scheduled_notifications sn
        SET status = 'claimed', claimed_at = now()
        FROM candidates c
        WHERE sn.id = c.id
        RETURNING sn.*;
      `);
      return rows.map(rowToDomain);
    });
  }
}
