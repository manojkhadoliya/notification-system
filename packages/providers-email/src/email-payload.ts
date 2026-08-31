/**
 * The `email` channel's contract for `ChannelCommand.renderedPayload` —
 * `domain-notification` deliberately doesn't interpret that field further
 * (see `channel-command.ts`'s doc comment: "a subject+body shape for
 * email"), so the gateway is where this shape gets defined, same call
 * `providers-sms`/`providers-push` made for their channels.
 * `services/router` (not yet built) is expected to populate `to` when it
 * resolves the recipient's email address and renders the template.
 */
export interface EmailRenderedPayload {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** Throws if `renderedPayload` doesn't match `EmailRenderedPayload` — a
 * malformed payload is a router/template bug, not a transient send
 * failure, which is why `MockEmailGateway` catches this and reports
 * `retryable: false` rather than letting it propagate. */
export function parseEmailPayload(
  renderedPayload: Record<string, unknown>,
): EmailRenderedPayload {
  const { to, subject, body } = renderedPayload;
  if (typeof to !== "string" || to.length === 0) {
    throw new Error("email renderedPayload.to must be a non-empty string");
  }
  if (typeof subject !== "string" || subject.length === 0) {
    throw new Error("email renderedPayload.subject must be a non-empty string");
  }
  if (typeof body !== "string" || body.length === 0) {
    throw new Error("email renderedPayload.body must be a non-empty string");
  }
  return { to, subject, body };
}
