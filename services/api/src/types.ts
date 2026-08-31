import type {
  ApiKeyRepository,
  RateLimiter,
} from "@notification-system/domain-identity";
import type {
  IdempotencyStore,
  MessageBroker,
  NotificationRepository,
} from "@notification-system/domain-notification";
import type { PreferenceRepository } from "@notification-system/domain-preferences";
import type { TemplateRepository } from "@notification-system/domain-templates";

/**
 * Every port a route handler is wired against — assembled once in
 * `index.ts` from concrete `infra-*` adapters, passed to `buildServer`.
 * `rateLimiter` is typed against `domain-identity`'s copy of the port
 * (rate limiting is described as an Identity & Tenancy concern in
 * multi-tenancy.md) — `infra-redis`'s `RedisRateLimiter` satisfies it
 * structurally, same as it satisfies `domain-notification`'s copy (see
 * that port's own doc comment for why two identical interfaces exist).
 */
export interface ApiDependencies {
  readonly apiKeyRepository: ApiKeyRepository;
  readonly notificationRepository: NotificationRepository;
  readonly preferenceRepository: PreferenceRepository;
  readonly templateRepository: TemplateRepository;
  readonly messageBroker: MessageBroker;
  readonly idempotencyStore: IdempotencyStore;
  readonly rateLimiter: RateLimiter;
}
