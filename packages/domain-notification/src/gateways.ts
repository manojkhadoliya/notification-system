import type { ChannelCommand } from "./channel-command.js";

/** Outcome of one provider call. `retryable` on failure is what
 * `DispatchService` uses to decide "requeue into the next retry tier" vs.
 * "this will never succeed, go straight to DLQ" (e.g. an invalid phone
 * number vs. a transient provider timeout) — see ADR 0010. */
export type GatewaySendResult =
  | { readonly success: true; readonly providerMessageId?: string }
  | {
      readonly success: false;
      readonly error: string;
      readonly retryable: boolean;
    };

/** Send through a concrete channel provider — per ADR 0004, all four
 * channels are built together, not phased. Implemented by
 * `providers-sms`/`providers-push`/`providers-email` (a real adapter and a
 * `mock` adapter, env-toggled) and, for `in_app`, by `infra-redis`'s
 * pub/sub (there's no external provider — see
 * messaging.md#in-app-is-structurally-different). */
export interface SmsGateway {
  send(command: ChannelCommand): Promise<GatewaySendResult>;
}

export interface PushGateway {
  send(command: ChannelCommand): Promise<GatewaySendResult>;
}

export interface EmailGateway {
  send(command: ChannelCommand): Promise<GatewaySendResult>;
}

export interface InAppGateway {
  send(command: ChannelCommand): Promise<GatewaySendResult>;
}
