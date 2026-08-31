import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  CHANNELS,
  isChannel,
  RecipientId,
} from "@notification-system/shared-kernel";
import {
  Preference,
  Recipient,
  quietHoursFromClock,
} from "@notification-system/domain-preferences";
import { badRequest, notFound } from "../errors.js";
import type { ApiDependencies } from "../types.js";

interface UpdatePreferenceBody {
  channel: string;
  notificationType: string;
  optedIn: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
}

const CLOCK_PATTERN = "^([01][0-9]|2[0-3]):[0-5][0-9]$";

const recipientParamsSchema = {
  params: {
    type: "object",
    required: ["recipientId"],
    properties: { recipientId: { type: "string", format: "uuid" } },
  },
} as const;

const updatePreferenceSchema = {
  ...recipientParamsSchema,
  body: {
    type: "object",
    required: ["channel", "notificationType", "optedIn"],
    additionalProperties: false,
    properties: {
      channel: { type: "string", enum: CHANNELS },
      notificationType: { type: "string", minLength: 1 },
      optedIn: { type: "boolean" },
      quietHoursStart: { type: "string", pattern: CLOCK_PATTERN },
      quietHoursEnd: { type: "string", pattern: CLOCK_PATTERN },
    },
  },
} as const;

function parseClock(value: string): { hour: number; minute: number } {
  const [hourPart, minutePart] = value.split(":");
  return { hour: Number(hourPart), minute: Number(minutePart) };
}

function formatClock(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export async function preferenceRoutes(
  app: FastifyInstance,
  deps: ApiDependencies,
): Promise<void> {
  app.get<{ Params: { recipientId: string } }>(
    "/v1/preferences/:recipientId",
    { schema: recipientParamsSchema },
    async (request) => {
      const recipientId = RecipientId(request.params.recipientId);
      const recipient =
        await deps.preferenceRepository.findRecipient(recipientId);
      if (recipient === null || recipient.tenantId !== request.tenantId) {
        throw notFound();
      }

      const preferences =
        await deps.preferenceRepository.findAllPreferences(recipientId);
      return preferences.map((preference) => ({
        channel: preference.channel,
        notificationType: preference.notificationType,
        optedIn: preference.optedIn,
        quietHoursStart: preference.quietHours
          ? formatClock(preference.quietHours.startMinute)
          : null,
        quietHoursEnd: preference.quietHours
          ? formatClock(preference.quietHours.endMinute)
          : null,
      }));
    },
  );

  app.put<{ Params: { recipientId: string }; Body: UpdatePreferenceBody }>(
    "/v1/preferences/:recipientId",
    { schema: updatePreferenceSchema },
    async (request) => {
      const recipientId = RecipientId(request.params.recipientId);
      const body = request.body;
      if (!isChannel(body.channel)) {
        throw badRequest(`invalid channel: ${body.channel}`);
      }
      if (
        (body.quietHoursStart === undefined) !==
        (body.quietHoursEnd === undefined)
      ) {
        throw badRequest(
          "quietHoursStart and quietHoursEnd must both be provided, or both omitted",
        );
      }

      let recipient =
        await deps.preferenceRepository.findRecipient(recipientId);
      if (recipient !== null && recipient.tenantId !== request.tenantId) {
        throw notFound();
      }
      if (recipient === null) {
        // api-spec.md has no recipient-creation endpoint — PUT
        // preferences is the first place a recipientId can legitimately
        // be referenced without prior setup, so it implicitly
        // provisions a bare Recipient row (no phone/pushToken/email yet)
        // rather than requiring an out-of-band step the spec never
        // defines.
        recipient = Recipient.create({
          id: recipientId,
          tenantId: request.tenantId,
        });
        await deps.preferenceRepository.saveRecipient(recipient);
      }

      const quietHours =
        body.quietHoursStart !== undefined && body.quietHoursEnd !== undefined
          ? quietHoursFromClock(
              parseClock(body.quietHoursStart).hour,
              parseClock(body.quietHoursStart).minute,
              parseClock(body.quietHoursEnd).hour,
              parseClock(body.quietHoursEnd).minute,
            )
          : null;

      const existing = await deps.preferenceRepository.findPreference(
        recipientId,
        body.channel,
        body.notificationType,
      );
      const preference = Preference.create({
        id: existing?.id ?? randomUUID(),
        recipientId,
        channel: body.channel,
        notificationType: body.notificationType,
        optedIn: body.optedIn,
        quietHours,
      });
      await deps.preferenceRepository.savePreference(preference);

      // api-spec.md doesn't define a PUT response body — echoing the
      // saved state back (same shape GET returns) is the least-surprising
      // choice.
      return {
        channel: preference.channel,
        notificationType: preference.notificationType,
        optedIn: preference.optedIn,
        quietHoursStart: body.quietHoursStart ?? null,
        quietHoursEnd: body.quietHoursEnd ?? null,
      };
    },
  );
}
