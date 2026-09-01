// In-memory fakes for every port `services/api` depends on, plus a
// `createTestContext()` that wires them into a ready-to-use
// `ApiDependencies` with one valid tenant/API-key pair preloaded. Used by
// every `routes/*.test.ts` file to drive real HTTP requests through
// `buildServer(...).inject(...)` without any live Postgres/Kafka/Redis —
// same "test against fakes behind the real port" approach
// `DispatchService`'s own test suite uses in `domain-notification`.
//
// Not a `*.test.ts` file itself (node's test runner glob only picks up
// `dist/**/*.test.js`), so it compiles to plain `dist/test-support.js`
// and imports cleanly from every test file that needs it.
import { randomUUID } from "node:crypto";
import type {
  ApiKeyRepository,
  RateLimiter,
} from "@notification-system/domain-identity";
import { ApiKey } from "@notification-system/domain-identity";
import type {
  ChannelCommand,
  DeliveryAttempt,
  DeliveryStatusEvent,
  IdempotencyRecord,
  IdempotencyStore,
  MessageBroker,
  NotificationEvent,
  NotificationRepository,
  NotificationRequest,
} from "@notification-system/domain-notification";
import type { PreferenceRepository } from "@notification-system/domain-preferences";
import { Preference, Recipient } from "@notification-system/domain-preferences";
import type { TemplateRepository } from "@notification-system/domain-templates";
import {
  Template,
  TemplateVersion,
} from "@notification-system/domain-templates";
import {
  ApiKeyId,
  type Channel,
  type NotificationRequestId,
  type RecipientId,
  TenantId,
  type TemplateId,
  type TemplateVersionId,
} from "@notification-system/shared-kernel";
import { hashApiKey } from "./hash-api-key.js";
import type { ApiDependencies } from "./types.js";

export class FakeApiKeyRepository implements ApiKeyRepository {
  private readonly byId = new Map<string, ApiKey>();
  private readonly byHashedKey = new Map<string, ApiKey>();

  add(apiKey: ApiKey): void {
    this.byId.set(apiKey.id, apiKey);
    this.byHashedKey.set(apiKey.hashedKey, apiKey);
  }

  async findById(id: ApiKeyId): Promise<ApiKey | null> {
    return this.byId.get(id) ?? null;
  }

  async findByHashedKey(hashedKey: string): Promise<ApiKey | null> {
    return this.byHashedKey.get(hashedKey) ?? null;
  }

  async save(apiKey: ApiKey): Promise<void> {
    this.add(apiKey);
  }
}

export class FakeNotificationRepository implements NotificationRepository {
  private readonly requests = new Map<string, NotificationRequest>();
  private readonly attempts = new Map<string, DeliveryAttempt[]>();

  seed(request: NotificationRequest, attempts: DeliveryAttempt[] = []): void {
    this.requests.set(request.id, request);
    this.attempts.set(request.id, attempts);
  }

  async findById(
    id: NotificationRequestId,
  ): Promise<NotificationRequest | null> {
    return this.requests.get(id) ?? null;
  }

  async save(request: NotificationRequest): Promise<void> {
    this.requests.set(request.id, request);
  }

  async findAttempts(id: NotificationRequestId): Promise<DeliveryAttempt[]> {
    return this.attempts.get(id) ?? [];
  }

  async saveAttempt(attempt: DeliveryAttempt): Promise<void> {
    const list = this.attempts.get(attempt.notificationRequestId) ?? [];
    list.push(attempt);
    this.attempts.set(attempt.notificationRequestId, list);
  }
}

export class FakePreferenceRepository implements PreferenceRepository {
  private readonly recipients = new Map<string, Recipient>();
  private readonly preferences: Preference[] = [];

  async findRecipient(id: RecipientId): Promise<Recipient | null> {
    return this.recipients.get(id) ?? null;
  }

  async saveRecipient(recipient: Recipient): Promise<void> {
    this.recipients.set(recipient.id, recipient);
  }

  async findRecipientIdsByTenant(tenantId: TenantId): Promise<RecipientId[]> {
    // Not exercised by services/api — that's services/fanout-expander's
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
  private readonly templates = new Map<string, Template>();
  private readonly versions: TemplateVersion[] = [];

  async findTemplate(id: TemplateId): Promise<Template | null> {
    return this.templates.get(id) ?? null;
  }

  async findTemplateByName(
    tenantId: string,
    name: string,
  ): Promise<Template | null> {
    for (const template of this.templates.values()) {
      if (template.tenantId === tenantId && template.name === name)
        return template;
    }
    return null;
  }

  async saveTemplate(template: Template): Promise<void> {
    this.templates.set(template.id, template);
  }

  async findVersion(id: TemplateVersionId): Promise<TemplateVersion | null> {
    return this.versions.find((v) => v.id === id) ?? null;
  }

  async findVersionHistory(templateId: TemplateId): Promise<TemplateVersion[]> {
    return this.versions
      .filter((v) => v.templateId === templateId)
      .sort((a, b) => a.version - b.version);
  }

  async findLatestVersion(
    templateId: TemplateId,
    locale: string,
  ): Promise<TemplateVersion | null> {
    const matches = this.versions.filter(
      (v) => v.templateId === templateId && v.locale === locale,
    );
    return matches.length === 0
      ? null
      : matches.reduce((max, v) => (v.version > max.version ? v : max));
  }

  async saveVersion(version: TemplateVersion): Promise<void> {
    this.versions.push(version);
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
    // Not exercised by services/api — POST /v1/notifications only ever
    // publishes events (see this package's README).
  }

  async publishToDlq(): Promise<void> {
    // Not exercised by services/api — see scheduleRetry's comment above.
  }

  async publishDeliveryStatus(event: DeliveryStatusEvent): Promise<void> {
    this.deliveryStatusEvents.push(event);
  }

  async publishBroadcast(): Promise<void> {
    // Not exercised by services/api — Door 1 only accepts a single
    // recipientId; broadcast is Door 2 only (see messaging.md).
  }

  async publishChunk(): Promise<void> {
    // Not exercised by services/api — see publishBroadcast's comment above.
  }
}

export class FakeIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async find(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null> {
    return this.records.get(`${tenantId}:${idempotencyKey}`) ?? null;
  }

  async reserve(
    tenantId: string,
    idempotencyKey: string,
    record: IdempotencyRecord,
  ): Promise<void> {
    this.records.set(`${tenantId}:${idempotencyKey}`, record);
  }
}

export class FakeRateLimiter implements RateLimiter {
  readonly calls: { tenantId: string; channel: Channel }[] = [];
  allow = true;

  async tryConsume(tenantId: string, channel: Channel): Promise<boolean> {
    this.calls.push({ tenantId, channel });
    return this.allow;
  }
}

export interface TestContext {
  readonly deps: ApiDependencies;
  readonly tenantId: TenantId;
  /** The raw (unhashed) key — pass via `authHeader()` in a request. */
  readonly apiKey: string;
  readonly fakes: {
    readonly apiKeyRepository: FakeApiKeyRepository;
    readonly notificationRepository: FakeNotificationRepository;
    readonly preferenceRepository: FakePreferenceRepository;
    readonly templateRepository: FakeTemplateRepository;
    readonly messageBroker: FakeMessageBroker;
    readonly idempotencyStore: FakeIdempotencyStore;
    readonly rateLimiter: FakeRateLimiter;
  };
}

export function createTestContext(): TestContext {
  const tenantId = TenantId(randomUUID());
  const apiKey = "test-raw-api-key";

  const apiKeyRepository = new FakeApiKeyRepository();
  apiKeyRepository.add(
    ApiKey.issue({
      id: ApiKeyId(randomUUID()),
      tenantId,
      hashedKey: hashApiKey(apiKey),
    }),
  );

  const fakes = {
    apiKeyRepository,
    notificationRepository: new FakeNotificationRepository(),
    preferenceRepository: new FakePreferenceRepository(),
    templateRepository: new FakeTemplateRepository(),
    messageBroker: new FakeMessageBroker(),
    idempotencyStore: new FakeIdempotencyStore(),
    rateLimiter: new FakeRateLimiter(),
  };

  return { tenantId, apiKey, deps: fakes, fakes };
}

export function authHeader(rawKey: string): { authorization: string } {
  return { authorization: `Bearer ${rawKey}` };
}
