import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ChannelCommand } from "@notification-system/domain-notification";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import {
  isRetryableTwilioStatus,
  TwilioSmsGateway,
  type TwilioConfig,
} from "./twilio-sms-gateway.js";

const config: TwilioConfig = {
  accountSid: "ACxxx",
  authToken: "secret",
  fromNumber: "+15550000000",
};
const command: ChannelCommand = {
  notificationRequestId: NotificationRequestId(randomUUID()),
  tenantId: TenantId(randomUUID()),
  recipientId: RecipientId(randomUUID()),
  channel: "sms",
  priority: "standard",
  renderedPayload: { to: "+15551234567", body: "hello" },
  attemptNumber: 1,
};

describe("isRetryableTwilioStatus", () => {
  it("treats 429 and every 5xx as retryable", () => {
    assert.equal(isRetryableTwilioStatus(429), true);
    assert.equal(isRetryableTwilioStatus(500), true);
    assert.equal(isRetryableTwilioStatus(503), true);
  });

  it("treats other 4xx as not retryable", () => {
    assert.equal(isRetryableTwilioStatus(400), false);
    assert.equal(isRetryableTwilioStatus(401), false);
    assert.equal(isRetryableTwilioStatus(404), false);
  });
});

describe("TwilioSmsGateway", () => {
  it("returns success with the provider message id on a 2xx response", async () => {
    let capturedUrl: Parameters<typeof fetch>[0] | undefined;
    let capturedInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ sid: "SM123" }), { status: 201 });
    };

    const gateway = new TwilioSmsGateway(config, fakeFetch);
    const result = await gateway.send(command);

    assert.deepEqual(result, { success: true, providerMessageId: "SM123" });
    assert.equal(
      capturedUrl,
      "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json",
    );
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as { Authorization: string };
    assert.ok(headers.Authorization.startsWith("Basic "));
    const sentParams = new URLSearchParams(capturedInit?.body as string);
    assert.equal(sentParams.get("To"), "+15551234567");
    assert.equal(sentParams.get("From"), "+15550000000");
    assert.equal(sentParams.get("Body"), "hello");
  });

  it("marks a 500 response as retryable", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "server error" }), {
        status: 500,
      });
    const gateway = new TwilioSmsGateway(config, fakeFetch);
    const result = await gateway.send(command);
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, true);
  });

  it("marks a 400 response (e.g. invalid number) as not retryable", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          message: "The 'To' number is not a valid phone number.",
        }),
        { status: 400 },
      );
    const gateway = new TwilioSmsGateway(config, fakeFetch);
    const result = await gateway.send(command);
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, false);
    assert.equal(
      !result.success && result.error,
      "The 'To' number is not a valid phone number.",
    );
  });

  it("marks a thrown network error as retryable", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("ECONNRESET");
    };
    const gateway = new TwilioSmsGateway(config, fakeFetch);
    const result = await gateway.send(command);
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, true);
  });

  it("rejects a malformed renderedPayload as not retryable, without calling fetch", async () => {
    let fetchCalled = false;
    const fakeFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };
    const gateway = new TwilioSmsGateway(config, fakeFetch);
    const result = await gateway.send({
      ...command,
      renderedPayload: { body: "no `to` field" },
    });
    assert.equal(result.success, false);
    assert.equal(!result.success && result.retryable, false);
    assert.equal(fetchCalled, false);
  });
});
