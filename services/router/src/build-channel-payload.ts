import type { Recipient } from "@notification-system/domain-preferences";
import type { Channel } from "@notification-system/shared-kernel";

/**
 * Assembles `ChannelCommand.renderedPayload` in the shape each
 * `providers-*` package's gateway expects — `providers-sms`'s
 * `{to, body}`, `providers-push`'s `{token, title, body}`,
 * `providers-email`'s `{to, subject, body}`, and (for `in_app`, which has
 * no external provider) a plain `{body}`.
 *
 * `title`/`subject` default to the raw `notificationType` string —
 * `TemplateVersion.content` is one Handlebars source producing one
 * rendered body, with no field yet for a channel that needs a second,
 * shorter piece of text (push's title, email's subject). See this
 * package's README for the full reasoning and what a real fix looks like
 * (a `TemplateVersion` schema change, not a router-side guess).
 */
export function buildChannelPayload(
  channel: Channel,
  recipient: Recipient,
  notificationType: string,
  renderedBody: string,
): Record<string, unknown> {
  switch (channel) {
    case "sms":
      return {
        to: requireAddress(recipient.phone, channel),
        body: renderedBody,
      };
    case "push":
      return {
        token: requireAddress(recipient.pushToken, channel),
        title: notificationType,
        body: renderedBody,
      };
    case "email":
      return {
        to: requireAddress(recipient.email, channel),
        subject: notificationType,
        body: renderedBody,
      };
    case "in_app":
      return { body: renderedBody };
  }
}

function requireAddress(address: string | null, channel: Channel): string {
  if (address === null) {
    // decideChannel already checked recipient.hasAddressFor(channel)
    // before returning "dispatch" — reaching this means that invariant
    // was violated by the caller, not a normal runtime condition.
    throw new Error(
      `buildChannelPayload called for channel "${channel}" but the recipient has no address for it`,
    );
  }
  return address;
}
