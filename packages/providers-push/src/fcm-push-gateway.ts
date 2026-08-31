import type {
  ChannelCommand,
  GatewaySendResult,
  PushGateway,
} from "@notification-system/domain-notification";
import { parsePushPayload } from "./push-payload.js";
import {
  buildFcmAssertionJwt,
  DEFAULT_FCM_TOKEN_URI,
  type ServiceAccountCredentials,
} from "./fcm-auth.js";

export interface FcmConfig {
  readonly projectId: string;
  readonly credentials: ServiceAccountCredentials;
}

// Refresh a bit before the cached token's actual expiry so a send in
// flight never races an expiring token.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** FCM HTTP v1's documented `error.status` values classify cleanly into
 * retryable (transient/server-side) vs. not (this exact request will
 * never succeed) — see
 * https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode.
 * Falls back to the HTTP status code for a status FCM didn't send. */
export function isRetryableFcmError(
  httpStatus: number,
  fcmErrorStatus?: string,
): boolean {
  switch (fcmErrorStatus) {
    case "UNAVAILABLE":
    case "INTERNAL":
    case "QUOTA_EXCEEDED":
      return true;
    case "INVALID_ARGUMENT":
    case "UNREGISTERED":
    case "SENDER_ID_MISMATCH":
    case "THIRD_PARTY_AUTH_ERROR":
      return false;
    default:
      return httpStatus === 429 || httpStatus >= 500;
  }
}

/**
 * `PushGateway` port implementation calling FCM's HTTP v1 API directly.
 * OAuth2 service-account auth (`fcm-auth.ts`) is done by hand with
 * `node:crypto` rather than `firebase-admin`/`google-auth-library` — same
 * "one well-documented HTTP flow isn't worth a dependency for" call
 * `providers-sms`'s Twilio adapter made. `fetchImpl`/`now` are
 * constructor seams for the same reason that adapter's `fetchImpl` is —
 * unit-testing request-building, token caching, and error classification
 * against a stub, not a live Firebase project.
 */
export class FcmPushGateway implements PushGateway {
  private cachedToken: { accessToken: string; expiresAtMs: number } | null =
    null;

  constructor(
    private readonly config: FcmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async send(command: ChannelCommand): Promise<GatewaySendResult> {
    let payload;
    try {
      payload = parsePushPayload(command.renderedPayload);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    }

    let accessToken: string;
    try {
      accessToken = await this.getAccessToken();
    } catch (err) {
      // A token-exchange failure could be a transient network/outage
      // issue as easily as a credentials misconfiguration; defaulting to
      // retryable bounds the blast radius via RetryPolicy.maxAttempts
      // rather than blackholing on a single hiccup — a persistent
      // credential problem still surfaces (every attempt fails
      // identically into the DLQ).
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }

    const url = `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`;
    const requestBody = {
      message: {
        token: payload.token,
        notification: { title: payload.title, body: payload.body },
        ...(payload.data ? { data: payload.data } : {}),
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      // Never reached FCM at all (DNS, connection reset, timeout) —
      // always transient from this adapter's point of view.
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }

    const responseBody = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    if (response.ok) {
      const name = responseBody?.name;
      return typeof name === "string"
        ? { success: true, providerMessageId: name }
        : { success: true };
    }

    const errorObj = responseBody?.error as Record<string, unknown> | undefined;
    const fcmStatus =
      typeof errorObj?.status === "string" ? errorObj.status : undefined;
    const message =
      typeof errorObj?.message === "string"
        ? errorObj.message
        : `FCM responded ${response.status}`;
    return {
      success: false,
      error: message,
      retryable: isRetryableFcmError(response.status, fcmStatus),
    };
  }

  private async getAccessToken(): Promise<string> {
    const nowMs = this.now();
    if (
      this.cachedToken &&
      this.cachedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > nowMs
    ) {
      return this.cachedToken.accessToken;
    }

    const nowSeconds = Math.floor(nowMs / 1000);
    const assertion = buildFcmAssertionJwt(this.config.credentials, nowSeconds);
    const tokenUri = this.config.credentials.tokenUri ?? DEFAULT_FCM_TOKEN_URI;
    const response = await this.fetchImpl(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) {
      throw new Error(`FCM token exchange failed: ${response.status}`);
    }
    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAtMs: nowMs + data.expires_in * 1000,
    };
    return this.cachedToken.accessToken;
  }
}
