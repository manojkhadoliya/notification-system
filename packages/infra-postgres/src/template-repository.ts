import type {
  PrismaClient,
  Template as PrismaTemplate,
  TemplateVersion as PrismaTemplateVersion,
} from "./prisma-client.js";
import type { Channel, TenantId } from "@notification-system/shared-kernel";
import {
  TemplateId,
  TemplateVersionId,
} from "@notification-system/shared-kernel";
import {
  Template,
  TemplateVersion,
  type Locale,
  type TemplateRepository,
} from "@notification-system/domain-templates";

function templateToDomain(row: PrismaTemplate): Template {
  return Template.reconstitute({
    id: TemplateId(row.id),
    tenantId: row.tenantId as TenantId,
    name: row.name,
    channel: row.channel as Channel,
    createdAt: row.createdAt,
  });
}

function versionToDomain(row: PrismaTemplateVersion): TemplateVersion {
  return TemplateVersion.reconstitute({
    id: TemplateVersionId(row.id),
    templateId: TemplateId(row.templateId),
    locale: row.locale,
    version: row.version,
    content: row.content,
    createdAt: row.createdAt,
  });
}

export class PostgresTemplateRepository implements TemplateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findTemplate(id: TemplateId): Promise<Template | null> {
    const row = await this.prisma.template.findUnique({ where: { id } });
    return row === null ? null : templateToDomain(row);
  }

  async findTemplateByName(
    tenantId: TenantId,
    name: string,
  ): Promise<Template | null> {
    const row = await this.prisma.template.findUnique({
      where: { tenantId_name: { tenantId, name } },
    });
    return row === null ? null : templateToDomain(row);
  }

  async saveTemplate(template: Template): Promise<void> {
    await this.prisma.template.upsert({
      where: { id: template.id },
      create: {
        id: template.id,
        tenantId: template.tenantId,
        name: template.name,
        channel: template.channel,
        createdAt: template.createdAt,
      },
      update: {},
    });
  }

  async findVersion(id: TemplateVersionId): Promise<TemplateVersion | null> {
    const row = await this.prisma.templateVersion.findUnique({
      where: { id },
    });
    return row === null ? null : versionToDomain(row);
  }

  async findLatestVersion(
    templateId: TemplateId,
    locale: Locale,
  ): Promise<TemplateVersion | null> {
    const row = await this.prisma.templateVersion.findFirst({
      where: { templateId, locale },
      orderBy: { version: "desc" },
    });
    return row === null ? null : versionToDomain(row);
  }

  async saveVersion(version: TemplateVersion): Promise<void> {
    await this.prisma.templateVersion.upsert({
      where: { id: version.id },
      create: {
        id: version.id,
        templateId: version.templateId,
        locale: version.locale,
        version: version.version,
        content: version.content,
        createdAt: version.createdAt,
      },
      // TemplateVersion rows are immutable once created (see its doc
      // comment) — an upsert here only ever inserts; `update` is empty on
      // purpose, not a shortcut.
      update: {},
    });
  }
}
