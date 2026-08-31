import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyTwilioSignature } from "./twilio-signature.js";

// Self-generated fixtures, computed with the same algorithm Twilio
// documents (no live account in this session to pull an official test
// vector from) — see the function's doc comment.
function sign(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

describe("verifyTwilioSignature", () => {
  const authToken = "test-auth-token";
  const url = "https://example.com/v1/webhooks/twilio";
  const params = {
    MessageSid: "SM123",
    MessageStatus: "delivered",
    To: "+15551234567",
  };

  it("accepts a correctly computed signature", () => {
    const signature = sign(authToken, url, params);
    assert.equal(
      verifyTwilioSignature(authToken, url, params, signature),
      true,
    );
  });

  it("is insensitive to the order params were supplied in (sorts internally)", () => {
    const signature = sign(authToken, url, params);
    const reordered = {
      To: params.To,
      MessageSid: params.MessageSid,
      MessageStatus: params.MessageStatus,
    };
    assert.equal(
      verifyTwilioSignature(authToken, url, reordered, signature),
      true,
    );
  });

  it("rejects a signature computed with the wrong auth token", () => {
    const signature = sign("a-different-token", url, params);
    assert.equal(
      verifyTwilioSignature(authToken, url, params, signature),
      false,
    );
  });

  it("rejects when a param value was tampered with after signing", () => {
    const signature = sign(authToken, url, params);
    const tampered = { ...params, MessageStatus: "failed" };
    assert.equal(
      verifyTwilioSignature(authToken, url, tampered, signature),
      false,
    );
  });

  it("rejects when the URL doesn't match what was signed", () => {
    const signature = sign(authToken, url, params);
    assert.equal(
      verifyTwilioSignature(
        authToken,
        "https://example.com/other-path",
        params,
        signature,
      ),
      false,
    );
  });

  it("rejects a garbage signature without throwing", () => {
    assert.equal(
      verifyTwilioSignature(authToken, url, params, "not-a-real-signature"),
      false,
    );
  });
});
