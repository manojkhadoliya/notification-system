import type {
  PrismaClient,
  Recipient as PrismaRecipient,
  Preference as PrismaPreference,
} from "./prisma-client.js";
import type { Channel } from "@notification-system/shared-kernel";
import { RecipientId, TenantId } from "@notification-system/shared-kernel";
import {
  Preference,
  Recipient,
  quietHoursFromClock,
  type PreferenceRepository,
  type QuietHours,
} from "@notification-system/domain-preferences";
import { minutesToPgTime, pgTimeToMinutes } from "./pg-time.js";

function recipientToDomain(row: PrismaRecipient): Recipient {
  return Recipient.reconstitute({
    id: RecipientId(row.id),
    tenantId: TenantId(row.tenantId),
    phone: row.phone,
    pushToken: row.pushToken,
    email: row.email,
    createdAt: row.createdAt,
  });
}

function toQuietHours(start: Date | null, end: Date | null): QuietHours | null {
  if (start === null || end === null) {
    return null;
  }
  const startMinute = pgTimeToMinutes(start);
  const endMinute = pgTimeToMinutes(end);
  return quietHoursFromClock(
    Math.floor(startMinute / 60),
    startMinute % 60,
    Math.floor(endMinute / 60),
    endMinute % 60,
  );
}

function preferenceToDomain(row: PrismaPreference): Preference {
  return Preference.reconstitute({
    id: row.id,
    recipientId: RecipientId(row.recipientId),
    channel: row.channel as Channel,
    notificationType: row.notificationType,
    optedIn: row.optedIn,
    quietHours: toQuietHours(row.quietHoursStart, row.quietHoursEnd),
    fallbackOrder:
      row.fallbackOrder.length === 0 ? null : (row.fallbackOrder as Channel[]),
  });
}

export class PostgresPreferenceRepository implements PreferenceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findRecipient(id: RecipientId): Promise<Recipient | null> {
    const row = await this.prisma.recipient.findUnique({ where: { id } });
    return row === null ? null : recipientToDomain(row);
  }

  async saveRecipient(recipient: Recipient): Promise<void> {
    await this.prisma.recipient.upsert({
      where: { id: recipient.id },
      create: {
        id: recipient.id,
        tenantId: recipient.tenantId,
        phone: recipient.phone,
        pushToken: recipient.pushToken,
        email: recipient.email,
        createdAt: recipient.createdAt,
      },
      update: {
        phone: recipient.phone,
        pushToken: recipient.pushToken,
        email: recipient.email,
      },
    });
  }

  async findPreferences(
    recipientId: RecipientId,
    notificationType: string,
  ): Promise<Preference[]> {
    const rows = await this.prisma.preference.findMany({
      where: { recipientId, notificationType },
    });
    return rows.map(preferenceToDomain);
  }

  async findAllPreferences(recipientId: RecipientId): Promise<Preference[]> {
    const rows = await this.prisma.preference.findMany({
      where: { recipientId },
    });
    return rows.map(preferenceToDomain);
  }

  async findPreference(
    recipientId: RecipientId,
    channel: Channel,
    notificationType: string,
  ): Promise<Preference | null> {
    const row = await this.prisma.preference.findUnique({
      where: {
        recipientId_channel_notificationType: {
          recipientId,
          channel,
          notificationType,
        },
      },
    });
    return row === null ? null : preferenceToDomain(row);
  }

  async savePreference(preference: Preference): Promise<void> {
    const quietHours = preference.quietHours;
    const quietHoursStart =
      quietHours === null ? null : minutesToPgTime(quietHours.startMinute);
    const quietHoursEnd =
      quietHours === null ? null : minutesToPgTime(quietHours.endMinute);
    const fallbackOrder = [...(preference.fallbackOrder ?? [])];

    await this.prisma.preference.upsert({
      where: { id: preference.id },
      create: {
        id: preference.id,
        recipientId: preference.recipientId,
        channel: preference.channel,
        notificationType: preference.notificationType,
        optedIn: preference.optedIn,
        quietHoursStart,
        quietHoursEnd,
        fallbackOrder,
      },
      update: {
        optedIn: preference.optedIn,
        quietHoursStart,
        quietHoursEnd,
        fallbackOrder,
      },
    });
  }
}
