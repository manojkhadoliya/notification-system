import { randomUUID } from "node:crypto";
import type {
  ChannelCommand,
  GatewaySendResult,
  EmailGateway,
} from "@notification-system/domain-notification";
import { parseEmailPayload } from "./email-payload.js";

export interface MockEmailGatewayOptions {
  /** Fraction of calls that succeed, `0`-`1`. Default `1` (always
   * succeeds) — set below 1 to exercise retry/backoff/DLQ without a real
   * provider or cost. */
  readonly successRate?: number;
  /** Simulated network/provider latency in ms before resolving. Default
   * `0`. */
  readonly latencyMs?: number;
  /** Injection seam for deterministic tests — defaults to `Math.random`. */
  readonly random?: () => number;
}

/**
 * `EmailGateway` port implementation that never calls a real provider —
 * lets the full pipeline (dedupe, rate limiting, retry ladder, DLQ) be
 * demoed and tested without an SES/SendGrid account. This is currently
 * the **only** `EmailGateway` adapter — unlike `providers-sms`/
 * `providers-push`, a real provider was deliberately deferred here
 * rather than picked between SES (AWS SigV4 signing — either a
 * hand-rolled implementation, notably more involved than Twilio/FCM's
 * schemes, or the AWS SDK, which breaks this repo's "no heavy SDK
 * dependency" pattern) and SendGrid; build one when there's an actual
 * need to send real email.
 */
export class MockEmailGateway implements EmailGateway {
  private readonly successRate: number;
  private readonly latencyMs: number;
  private readonly random: () => number;

  constructor(options: MockEmailGatewayOptions = {}) {
    this.successRate = options.successRate ?? 1;
    this.latencyMs = options.latencyMs ?? 0;
    this.random = options.random ?? Math.random;
  }

  async send(command: ChannelCommand): Promise<GatewaySendResult> {
    let payload;
    try {
      payload = parseEmailPayload(command.renderedPayload);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    }

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    if (this.random() < this.successRate) {
      return { success: true, providerMessageId: `mock-${randomUUID()}` };
    }
    // A mock exists to exercise the retry pipeline, so its induced
    // failures look transient by default — same call
    // MockSmsGateway/MockPushGateway make.
    return {
      success: false,
      error: `mock: simulated failure sending to ${payload.to}`,
      retryable: true,
    };
  }
}
