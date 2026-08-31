/**
 * The `sms` channel's contract for `ChannelCommand.renderedPayload` —
 * `domain-notification` deliberately doesn't interpret that field further
 * (see `channel-command.ts`'s doc comment: "domain-notification doesn't
 * interpret this further, only carries and hands it to the gateway"), so
 * the gateway is where this shape gets defined. `services/router` (not
 * yet built) is expected to populate `to`/`body` when it resolves the
 * recipient's phone number and renders the template — this is the one
 * place that convention needs to be written down.
 */
export interface SmsRenderedPayload {
  readonly to: string;
  readonly body: string;
}

/** Throws if `renderedPayload` doesn't match `SmsRenderedPayload` — a
 * malformed payload is a router/template bug, not a transient send
 * failure, which is why every gateway here catches this and reports
 * `retryable: false` rather than letting it propagate. */
export function parseSmsPayload(
  renderedPayload: Record<string, unknown>,
): SmsRenderedPayload {
  const { to, body } = renderedPayload;
  if (typeof to !== "string" || to.length === 0) {
    throw new Error("sms renderedPayload.to must be a non-empty string");
  }
  if (typeof body !== "string" || body.length === 0) {
    throw new Error("sms renderedPayload.body must be a non-empty string");
  }
  return { to, body };
}
