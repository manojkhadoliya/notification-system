import type {
  MessageBroker,
  ScheduledNotificationRepository,
} from "@notification-system/domain-notification";
import type { PreferenceRepository } from "@notification-system/domain-preferences";
import type { TemplateRepository } from "@notification-system/domain-templates";

/** Every port `RouterService` is wired against — assembled once in
 * `index.ts` from concrete `infra-*` adapters. */
export interface RouterDependencies {
  readonly preferenceRepository: PreferenceRepository;
  readonly templateRepository: TemplateRepository;
  readonly scheduledNotificationRepository: ScheduledNotificationRepository;
  readonly messageBroker: MessageBroker;
}
