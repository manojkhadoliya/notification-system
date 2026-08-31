/**
 * The `push` channel's contract for `ChannelCommand.renderedPayload` —
 * `domain-notification` deliberately doesn't interpret that field further
 * (see `channel-command.ts`'s doc comment), so the gateway is where this
 * shape gets defined, same call `providers-sms` made for `sms`.
 * `services/router` (not yet built) is expected to populate `token`
 * (the recipient's FCM registration token) when it renders the template.
 */
export interface PushRenderedPayload {
  readonly token: string;
  readonly title: string;
  readonly body: string;
  /** FCM's `data` payload is string-valued only — enforced here so a
   * malformed payload fails fast at the gateway, not deep inside FCM's
   * response. */
  readonly data?: Record<string, string>;
}

/** Throws if `renderedPayload` doesn't match `PushRenderedPayload` — a
 * malformed payload is a router/template bug, not a transient send
 * failure, which is why every gateway here catches this and reports
 * `retryable: false` rather than letting it propagate. */
export function parsePushPayload(
  renderedPayload: Record<string, unknown>,
): PushRenderedPayload {
  const { token, title, body, data } = renderedPayload;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("push renderedPayload.token must be a non-empty string");
  }
  if (typeof title !== "string" || title.length === 0) {
    throw new Error("push renderedPayload.title must be a non-empty string");
  }
  if (typeof body !== "string" || body.length === 0) {
    throw new Error("push renderedPayload.body must be a non-empty string");
  }
  if (data !== undefined) {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(
        "push renderedPayload.data must be an object of string values",
      );
    }
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== "string") {
        throw new Error(
          `push renderedPayload.data.${key} must be a string (FCM data payloads are string-valued)`,
        );
      }
    }
  }
  return data !== undefined
    ? { token, title, body, data: data as Record<string, string> }
    : { token, title, body };
}
