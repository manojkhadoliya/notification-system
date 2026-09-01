// In-memory fakes for every port `services/router` depends on. Used by
// `router-service.test.ts` — same "test against fakes behind the real
// port" approach `DispatchService`'s own suite (in `domain-notification`)
// and `services/api`'s route tests use. Not a `*.test.ts` file itself, so
// it compiles to plain `dist/test-support.js` and imports cleanly from
// whichever test file needs it.
import type {
  ChannelCommand,
  DeliveryStatusEvent,
  MessageBroker,
  NotificationEvent,
  ScheduledNotification,
  ScheduledNotificationRepository,
} from "@notification-system/domain-notification";
import type {
  Preference,
  PreferenceRepository,
  Recipient,
} from "@notification-system/domain-preferences";
import type { TemplateRepository } from "@notification-system/domain-templates";
import {
  Template,
  TemplateVersion,
} from "@notification-system/domain-templates";
import type {
  Channel,
  RecipientId,
  TemplateVersionId,
  TenantId,
} from "@notification-system/shared-kernel";

export class FakePreferenceRepository implements PreferenceRepository {
  private readonly recipients = new Map<string, Recipient>();
  private readonly preferences: Preference[] = [];

  seedRecipient(recipient: Recipient): void {
    this.recipients.set(recipient.id, recipient);
  }

  seedPreference(preference: Preference): void {
    this.preferences.push(preference);
  }

  async findRecipient(id: RecipientId): Promise<Recipient | null> {
    return this.recipients.get(id) ?? null;
  }

  async saveRecipient(recipient: Recipient): Promise<void> {
    this.recipients.set(recipient.id, recipient);
  }

  async findRecipientIdsByTenant(tenantId: TenantId): Promise<RecipientId[]> {
    // Not exercised by services/router — that's services/fanout-expander's
    // job — but trivial to implement for real from what's already seeded.
    return [...this.recipients.values()]
      .filter((r) => r.tenantId === tenantId)
      .map((r) => r.id);
  }

  async findPreferences(
    recipientId: RecipientId,
    notificationType: string,
  ): Promise<Preference[]> {
    return this.preferences.filter(
      (p) =>
        p.recipientId === recipientId &&
        p.notificationType === notificationType,
    );
  }

  async findAllPreferences(recipientId: RecipientId): Promise<Preference[]> {
    return this.preferences.filter((p) => p.recipientId === recipientId);
  }

  async findPreference(
    recipientId: RecipientId,
    channel: Channel,
    notificationType: string,
  ): Promise<Preference | null> {
    return (
      this.preferences.find(
        (p) =>
          p.recipientId === recipientId &&
          p.channel === channel &&
          p.notificationType === notificationType,
      ) ?? null
    );
  }

  async savePreference(preference: Preference): Promise<void> {
    const index = this.preferences.findIndex((p) => p.id === preference.id);
    if (index >= 0) {
      this.preferences[index] = preference;
    } else {
      this.preferences.push(preference);
    }
  }
}

export class FakeTemplateRepository implements TemplateRepository {
  private readonly versions = new Map<string, TemplateVersion>();

  seedVersion(version: TemplateVersion): void {
    this.versions.set(version.id, version);
  }

  async findTemplate(): Promise<Template | null> {
    return null; // not exercised by services/router
  }

  async findTemplateByName(): Promise<Template | null> {
    return null; // not exercised by services/router
  }

  async saveTemplate(): Promise<void> {
    // not exercised by services/router
  }

  async findVersion(id: TemplateVersionId): Promise<TemplateVersion | null> {
    return this.versions.get(id) ?? null;
  }

  async findVersionHistory(): Promise<TemplateVersion[]> {
    return []; // not exercised by services/router
  }

  async findLatestVersion(): Promise<TemplateVersion | null> {
    return null; // not exercised by services/router — see this package's README
  }

  async saveVersion(version: TemplateVersion): Promise<void> {
    this.versions.set(version.id, version);
  }
}

export class FakeScheduledNotificationRepository implements ScheduledNotificationRepository {
  readonly saved: ScheduledNotification[] = [];

  async save(notification: ScheduledNotification): Promise<void> {
    this.saved.push(notification);
  }

  async claimDue(): Promise<ScheduledNotification[]> {
    return []; // not exercised by services/router — services/scheduler's job
  }
}

export class FakeMessageBroker implements MessageBroker {
  readonly publishedEvents: NotificationEvent[] = [];
  readonly publishedCommands: ChannelCommand[] = [];
  readonly deliveryStatusEvents: DeliveryStatusEvent[] = [];

  async publishEvent(event: NotificationEvent): Promise<void> {
    this.publishedEvents.push(event);
  }

  async publishCommand(command: ChannelCommand): Promise<void> {
    this.publishedCommands.push(command);
  }

  async scheduleRetry(): Promise<void> {
    // Not exercised by services/router — that's the channel workers' job.
  }

  async publishToDlq(): Promise<void> {
    // Not exercised by services/router — see scheduleRetry's comment above.
  }

  async publishDeliveryStatus(event: DeliveryStatusEvent): Promise<void> {
    this.deliveryStatusEvents.push(event);
  }

  async publishBroadcast(): Promise<void> {
    // Not exercised by services/router — that's services/fanout-expander's job.
  }

  async publishChunk(): Promise<void> {
    // Not exercised by services/router — see publishBroadcast's comment above.
  }
}
