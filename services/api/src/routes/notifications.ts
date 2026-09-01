import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  CHANNELS,
  isChannel,
  NotificationRequestId,
  RecipientId,
  TemplateVersionId,
} from "@notification-system/shared-kernel";
import type { NotificationEvent } from "@notification-system/domain-notification";
import { badRequest, conflict, notFound, tooManyRequests } from "../errors.js";
import type { ApiDependencies } from "../types.js";

interface CreateNotificationBody {
  recipientId: string;
  notificationType: string;
  channel?: string;
  templateVersionId?: string;
  payload: Record<string, unknown>;
}

const createNotificationSchema = {
  body: {
    type: "object",
    required: ["recipientId", "notificationType", "payload"],
    additionalProperties: false,
    properties: {
      recipientId: { type: "string", format: "uuid" },
      notificationType: { type: "string", minLength: 1 },
      channel: { type: "string", enum: CHANNELS },
      templateVersionId: { type: "string", format: "uuid" },
      payload: { type: "object" },
    },
  },
} as const;

const getNotificationSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } },
  },
} as const;

/** Canonicalizes the fields of `POST /v1/notifications` that determine
 * whether a redelivery under the same `Idempotency-Key` is a safe retry
 * (identical) or a real conflict (different) — see
 * multi-tenancy.md#idempotency. Plain `JSON.stringify` of an
 * already-fixed key order, not a general canonical-JSON algorithm; good
 * enough since this object's shape never varies. */
function hashRequestPayload(body: CreateNotificationBody): string {
  const canonical = JSON.stringify({
    recipientId: body.recipientId,
    notificationType: body.notificationType,
    channel: body.channel ?? null,
    templateVersionId: body.templateVersionId ?? null,
    payload: body.payload,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export async function notificationRoutes(
  app: FastifyInstance,
  deps: ApiDependencies,
): Promise<void> {
  app.post<{ Body: CreateNotificationBody }>(
    "/v1/notifications",
    { schema: createNotificationSchema },
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
        throw badRequest("Idempotency-Key header is required");
      }

      const body = request.body;
      if (body.channel !== undefined && !isChannel(body.channel)) {
        throw badRequest(`invalid channel: ${body.channel}`);
      }

      const payloadHash = hashRequestPayload(body);
      const existing = await deps.idempotencyStore.find(
        request.tenantId,
        idempotencyKey,
      );
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) {
          throw conflict(
            "Idempotency-Key already used for a different request payload",
          );
        }
        // Safe retry — the response body is minimal enough (id + a status
        // that's always "accepted" at this point) that it can be served
        // straight from the idempotency record, without a
        // NotificationRepository round trip (the read-model row for this
        // id may not even exist yet — see this package's README on why
        // POST never touches NotificationRepository).
        reply.status(202);
        return { id: existing.notificationRequestId, status: "accepted" };
      }

      // Ingest-time rate limiting is per (tenantId, channel) per
      // multi-tenancy.md#rate-limiting, but at Door 1 the channel is often
      // not known yet — that's the router's decision downstream (see
      // messaging.md#router). So this only enforces the limit when the
      // caller explicitly requested a channel; an unrouted request is
      // capped later, at dispatch time, once a channel is actually
      // resolved (the same enforcement point every request eventually
      // passes through regardless).
      if (body.channel !== undefined && isChannel(body.channel)) {
        const allowed = await deps.rateLimiter.tryConsume(
          request.tenantId,
          body.channel,
        );
        if (!allowed) {
          throw tooManyRequests();
        }
      }

      const notificationRequestId = NotificationRequestId(randomUUID());
      const event: NotificationEvent = {
        notificationRequestId,
        tenantId: request.tenantId,
        recipientId: RecipientId(body.recipientId),
        notificationType: body.notificationType,
        channel:
          body.channel !== undefined && isChannel(body.channel)
            ? body.channel
            : null,
        templateVersionId:
          body.templateVersionId !== undefined
            ? TemplateVersionId(body.templateVersionId)
            : null,
        payloadRef: body.payload,
        // api-spec.md's request body has no priority field for Door 1 —
        // every tenant-facing request defaults to "standard" until the
        // spec grows one; see this package's README.
        priority: "standard",
        broadcastId: null,
        idempotencyKey,
      };
      await deps.messageBroker.publishEvent(event);
      await deps.idempotencyStore.reserve(request.tenantId, idempotencyKey, {
        payloadHash,
        notificationRequestId,
      });

      reply.status(202);
      return { id: notificationRequestId, status: "accepted" };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/notifications/:id",
    { schema: getNotificationSchema },
    async (request) => {
      const id = NotificationRequestId(request.params.id);
      const found = await deps.notificationRepository.findById(id);
      // A wrong-tenant match is reported identically to "doesn't exist" —
      // 404, not 403 — so a response never confirms another tenant's
      // notification even exists.
      if (found === null || found.tenantId !== request.tenantId) {
        throw notFound();
      }
      const attempts = await deps.notificationRepository.findAttempts(id);
      return {
        id: found.id,
        channel: found.channel,
        status: found.status,
        attempts: attempts.map((attempt) => ({
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          createdAt: attempt.createdAt,
        })),
      };
    },
  );
}
