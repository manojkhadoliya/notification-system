import type {
  ChannelCommand,
  GatewaySendResult,
  SmsGateway,
} from "@notification-system/domain-notification";
import { parseSmsPayload } from "./sms-payload.js";

export interface TwilioConfig {
  readonly accountSid: string;
  readonly authToken: string;
  readonly fromNumber: string;
}

/** A 429 (rate limited) or 5xx (Twilio-side failure) is transient — retry
 * with backoff, per `RetryPolicy`. Any other 4xx (invalid phone number,
 * unsubscribed recipient, malformed request, bad credentials, ...) will
 * fail identically on every retry, so it goes straight to the DLQ instead
 * — same "invalid input vs. transient provider timeout" split
 * `GatewaySendResult.retryable`'s doc comment describes. */
export function isRetryableTwilioStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * `SmsGateway` port implementation, calling Twilio's REST API directly
 * over `fetch` rather than pulling in the `twilio` SDK — this is one HTTP
 * call with a well-documented shape, not worth a dependency for.
 * `fetchImpl` is a constructor seam (defaults to the global `fetch`) so
 * `send()`'s request-building and status-classification logic can be
 * unit-tested against a stub instead of a live Twilio account — see
 * `twilio-sms-gateway.test.ts`.
 */
export class TwilioSmsGateway implements SmsGateway {
  constructor(
    private readonly config: TwilioConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(command: ChannelCommand): Promise<GatewaySendResult> {
    let payload;
    try {
      payload = parseSmsPayload(command.renderedPayload);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
    const body = new URLSearchParams({
      To: payload.to,
      From: this.config.fromNumber,
      Body: payload.body,
    });
    const auth = Buffer.from(
      `${this.config.accountSid}:${this.config.authToken}`,
    ).toString("base64");

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch (err) {
      // A network-level failure (DNS, connection reset, timeout) never
      // reaches Twilio at all — always transient from this adapter's
      // point of view.
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }

    const responseBody = await response.json().catch(() => null);

    if (response.ok) {
      const sid =
        responseBody && typeof responseBody === "object"
          ? (responseBody as Record<string, unknown>).sid
          : undefined;
      return typeof sid === "string"
        ? { success: true, providerMessageId: sid }
        : { success: true };
    }

    const message =
      responseBody &&
      typeof responseBody === "object" &&
      typeof (responseBody as Record<string, unknown>).message === "string"
        ? ((responseBody as Record<string, unknown>).message as string)
        : `Twilio responded ${response.status}`;
    return {
      success: false,
      error: message,
      retryable: isRetryableTwilioStatus(response.status),
    };
  }
}
