import type {
  TemplateId,
  TemplateVersionId,
  TenantId,
} from "@notification-system/shared-kernel";
import type { Template } from "./template.js";
import type { Locale, TemplateVersion } from "./template-version.js";

export interface TemplateRepository {
  findTemplate(id: TemplateId): Promise<Template | null>;
  findTemplateByName(
    tenantId: TenantId,
    name: string,
  ): Promise<Template | null>;
  saveTemplate(template: Template): Promise<void>;

  findVersion(id: TemplateVersionId): Promise<TemplateVersion | null>;
  /** The version `services/router` resolves to when a request specifies a
   * `notificationType` + channel but not an explicit `templateVersionId`
   * — see messaging.md#router. "Latest" is scoped per locale, since two
   * locales of the same template version independently. */
  findLatestVersion(
    templateId: TemplateId,
    locale: Locale,
  ): Promise<TemplateVersion | null>;
  saveVersion(version: TemplateVersion): Promise<void>;
}
