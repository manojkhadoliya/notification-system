import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  CHANNELS,
  isChannel,
  TemplateId,
  TemplateVersionId,
} from "@notification-system/shared-kernel";
import {
  Template,
  TemplateVersion,
} from "@notification-system/domain-templates";
import { badRequest, notFound } from "../errors.js";
import type { ApiDependencies } from "../types.js";

interface CreateTemplateBody {
  name: string;
  channel: string;
}

interface PublishVersionBody {
  locale: string;
  content: string;
}

const createTemplateSchema = {
  body: {
    type: "object",
    required: ["name", "channel"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
      channel: { type: "string", enum: CHANNELS },
    },
  },
} as const;

const templateIdParamsSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } },
  },
} as const;

const publishVersionSchema = {
  ...templateIdParamsSchema,
  body: {
    type: "object",
    required: ["locale", "content"],
    additionalProperties: false,
    properties: {
      locale: { type: "string", minLength: 1 },
      content: { type: "string", minLength: 1 },
    },
  },
} as const;

export async function templateRoutes(
  app: FastifyInstance,
  deps: ApiDependencies,
): Promise<void> {
  app.post<{ Body: CreateTemplateBody }>(
    "/v1/templates",
    { schema: createTemplateSchema },
    async (request, reply) => {
      const body = request.body;
      if (!isChannel(body.channel)) {
        throw badRequest(`invalid channel: ${body.channel}`);
      }

      const template = Template.create({
        id: TemplateId(randomUUID()),
        tenantId: request.tenantId,
        name: body.name,
        channel: body.channel,
      });
      await deps.templateRepository.saveTemplate(template);

      reply.status(201);
      return {
        id: template.id,
        name: template.name,
        channel: template.channel,
        createdAt: template.createdAt,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: PublishVersionBody }>(
    "/v1/templates/:id/versions",
    { schema: publishVersionSchema },
    async (request, reply) => {
      const templateId = TemplateId(request.params.id);
      const template = await deps.templateRepository.findTemplate(templateId);
      if (template === null || template.tenantId !== request.tenantId) {
        throw notFound();
      }

      // "Latest" is scoped per locale (see findLatestVersion's doc
      // comment) — two locales of the same template version
      // independently, so the next version number for *this* locale is
      // one past whatever's already published in it, not a global
      // counter across every locale.
      const latest = await deps.templateRepository.findLatestVersion(
        templateId,
        request.body.locale,
      );
      const version = TemplateVersion.publish({
        id: TemplateVersionId(randomUUID()),
        templateId,
        locale: request.body.locale,
        version: (latest?.version ?? 0) + 1,
        content: request.body.content,
      });
      await deps.templateRepository.saveVersion(version);

      reply.status(201);
      return { id: version.id, version: version.version };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/templates/:id",
    { schema: templateIdParamsSchema },
    async (request) => {
      const templateId = TemplateId(request.params.id);
      const template = await deps.templateRepository.findTemplate(templateId);
      if (template === null || template.tenantId !== request.tenantId) {
        throw notFound();
      }

      const versions =
        await deps.templateRepository.findVersionHistory(templateId);
      return {
        id: template.id,
        name: template.name,
        channel: template.channel,
        createdAt: template.createdAt,
        versions: versions.map((version) => ({
          id: version.id,
          locale: version.locale,
          version: version.version,
          createdAt: version.createdAt,
        })),
      };
    },
  );
}
