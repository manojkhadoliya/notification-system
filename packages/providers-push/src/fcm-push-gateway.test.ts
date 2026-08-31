import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { ChannelCommand } from "@notification-system/domain-notification";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import { DEFAULT_FCM_TOKEN_URI } from "./fcm-auth.js";
import {
  FcmPushGateway,
  isRetryableFcmError,
  type FcmConfig,
} from "./fcm-push-gateway.js";

// A throwaway keypair is enough for node:crypto's createSign to succeed —
// nothing here needs the JWT to actually verify against Google, only
// that signing doesn't throw, so the token-exchange call can be reached.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const config: FcmConfig = {
  projectId: "test-project",
  credentials: {
    clientEmail: "test@test-project.iam.gserviceaccount.com",
    privateKey,
  },
};
const sendUrl = `https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`;
const command: ChannelCommand = {
  notificationRequestId: NotificationRequestId(randomUUID()),
  tenantId: TenantId(randomUUID()),
  recipientId: RecipientId(randomUUID()),
  channel: "push",
  priority: "standard",
  renderedPayload: { token: "fcm-token", title: "Hi", body: "hello" },
  attemptNumber: 1,
};

/** Routes a fake fetch to a token-exchange responder and a
 * messages:send responder based on the URL, and counts calls to each. */
function makeRoutedFetch(options: {
  tokenResponse: () => Response;
  sendResponse: () => Response;
}) {
  const calls = { token: 0, send: 0 };
  const fetchImpl: typeof fetch = async (url) => {
    if (url === DEFAULT_FCM_TOKEN_URI) {
      calls.token += 1;
      return options.tokenResponse();
    }
    if (url === sendUrl) {
      calls.send += 1;
      return options.sendResponse();
    }
    throw new Error(`unexpected fetch to ${String(url)}`);
  };
  return { fetchImpl, calls };
}

describe("isRetryableFcmError", () => {
  it("treats UNAVAILABLE/INTERNAL/QUOTA_EXCEEDED as retryable", () => {
    assert.equal(isRetryableFcmError(503, "UNAVAILABLE"), true);
    assert.equal(isRetryableFcmError(500, "INTERNAL"), true);
    assert.equal(isRetryableFcmError(429, "QUOTA_EXCEEDED"), true);
  });

  it("treats INVALID_ARGUMENT/UNREGISTERED/SENDER_ID_MISMATCH/THIRD_PARTY_AUTH_ERROR as not retryable", () => {
    assert.equal(isRetryableFcmError(400, "INVALID_ARGUMENT"), false);
    assert.equal(isRetryableFcmError(404, "UNREGISTERED"), false);
    assert.equal(isRetryableFcmError(403, "SENDER_ID_MISMATCH"), false);
    assert.equal(isRetryableFcmError(401, "THIRD_PARTY_AUTH_ERROR"), false);
  });

  it("falls back to the HTTP status when FCM sends no recognized status", () => {
    assert.equal(isRetryableFcmError(502, undefined), true);
    assert.equal(isRetryableFcmError(418, undefined), false);
  });
});

describe("FcmPushGateway", () => {
  it("rejects a malformed renderedPayload as not retryable, without calling fetch", async () => {
    const { fetchImpl, calls } = makeRoutedFetch({
      tokenResponse: () => new Response("{}", { status: 200 }),
      sendResponse: () => new Response("{}", { status: 200 }),
    });
    const gateway = new FcmPushGateway(config, fetchImpl);
    const result = await gateway.send({
      ...command,
      renderedPayload: { title: "no token" },
    });
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, false);
    assert.equal(calls.token + calls.send, 0);
  });

  it("exchanges for a token, sends, and returns the provider message id", async () => {
    const { fetchImpl, calls } = makeRoutedFetch({
      tokenResponse: () =>
        new Response(
          JSON.stringify({ access_token: "abc", expires_in: 3600 }),
          { status: 200 },
        ),
      sendResponse: () =>
        new Response(JSON.stringify({ name: "projects/p/messages/123" }), {
          status: 200,
        }),
    });
    const gateway = new FcmPushGateway(config, fetchImpl);
    const result = await gateway.send(command);
    assert.deepEqual(result, {
      success: true,
      providerMessageId: "projects/p/messages/123",
    });
    assert.equal(calls.token, 1);
    assert.equal(calls.send, 1);
  });

  it("caches the token across calls and only re-exchanges after it's near expiry", async () => {
    const { fetchImpl, calls } = makeRoutedFetch({
      tokenResponse: () =>
        new Response(
          JSON.stringify({ access_token: "abc", expires_in: 3600 }),
          { status: 200 },
        ),
      sendResponse: () =>
        new Response(JSON.stringify({ name: "m1" }), { status: 200 }),
    });
    let nowMs = 0;
    const gateway = new FcmPushGateway(config, fetchImpl, () => nowMs);

    await gateway.send(command);
    assert.equal(calls.token, 1);

    nowMs += 10_000; // well within the 3600s token lifetime
    await gateway.send(command);
    assert.equal(
      calls.token,
      1,
      "second send within the token's lifetime must not re-exchange",
    );
    assert.equal(calls.send, 2);

    nowMs += 3600 * 1000; // past expiry (minus the refresh margin)
    await gateway.send(command);
    assert.equal(
      calls.token,
      2,
      "a send after the token expired must re-exchange",
    );
  });

  it("marks a non-ok token-exchange response as retryable", async () => {
    const { fetchImpl } = makeRoutedFetch({
      tokenResponse: () => new Response("unauthorized_client", { status: 401 }),
      sendResponse: () => new Response("{}", { status: 200 }),
    });
    const gateway = new FcmPushGateway(config, fetchImpl);
    const result = await gateway.send(command);
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, true);
  });

  it("marks an FCM UNREGISTERED error as not retryable", async () => {
    const { fetchImpl } = makeRoutedFetch({
      tokenResponse: () =>
        new Response(
          JSON.stringify({ access_token: "abc", expires_in: 3600 }),
          { status: 200 },
        ),
      sendResponse: () =>
        new Response(
          JSON.stringify({
            error: {
              status: "UNREGISTERED",
              message: "the registration token is no longer valid",
            },
          }),
          { status: 404 },
        ),
    });
    const gateway = new FcmPushGateway(config, fetchImpl);
    const result = await gateway.send(command);
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, false);
    assert.equal(
      !result.success && result.error,
      "the registration token is no longer valid",
    );
  });

  it("marks a thrown network error during send as retryable", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      if (url === DEFAULT_FCM_TOKEN_URI) {
        return new Response(
          JSON.stringify({ access_token: "abc", expires_in: 3600 }),
          { status: 200 },
        );
      }
      throw new Error("ECONNRESET");
    };
    const gateway = new FcmPushGateway(config, fetchImpl);
    const result = await gateway.send(command);
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, true);
  });
});
