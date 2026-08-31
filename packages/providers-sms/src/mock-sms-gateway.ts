import { randomUUID } from "node:crypto";
import type {
  ChannelCommand,
  GatewaySendResult,
  SmsGateway,
} from "@notification-system/domain-notification";
import { parseSmsPayload } from "./sms-payload.js";

export interface MockSmsGatewayOptions {
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
 * `SmsGateway` port implementation that never calls a real provider —
 * lets the full pipeline (dedupe, rate limiting, retry ladder, DLQ) be
 * demoed and tested without a Twilio account. Selected instead of
 * `TwilioSmsGateway` by whichever composition root's env config asks for
 * it (this package never reads `process.env` itself — same pattern as
 * every other adapter in this repo).
 */
export class MockSmsGateway implements SmsGateway {
  private readonly successRate: number;
  private readonly latencyMs: number;
  private readonly random: () => number;

  constructor(options: MockSmsGatewayOptions = {}) {
    this.successRate = options.successRate ?? 1;
    this.latencyMs = options.latencyMs ?? 0;
    this.random = options.random ?? Math.random;
  }

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

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    if (this.random() < this.successRate) {
      return { success: true, providerMessageId: `mock-${randomUUID()}` };
    }
    // A mock exists to exercise the retry pipeline, so its induced
    // failures look transient by default — a caller wanting to test the
    // DLQ path directly should drive that through `RetryPolicy.maxAttempts`
    // exhausting, not by needing a non-retryable failure mode here.
    return {
      success: false,
      error: `mock: simulated failure sending to ${payload.to}`,
      retryable: true,
    };
  }
}
