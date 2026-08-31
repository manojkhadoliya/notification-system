import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSmsPayload } from "./sms-payload.js";

describe("parseSmsPayload", () => {
  it("accepts a valid payload", () => {
    const result = parseSmsPayload({ to: "+15551234567", body: "hello" });
    assert.deepEqual(result, { to: "+15551234567", body: "hello" });
  });

  it("throws if `to` is missing", () => {
    assert.throws(
      () => parseSmsPayload({ body: "hello" }),
      /renderedPayload\.to/,
    );
  });

  it("throws if `to` is not a string", () => {
    assert.throws(
      () => parseSmsPayload({ to: 12345, body: "hello" }),
      /renderedPayload\.to/,
    );
  });

  it("throws if `body` is missing", () => {
    assert.throws(
      () => parseSmsPayload({ to: "+15551234567" }),
      /renderedPayload\.body/,
    );
  });

  it("throws if `body` is an empty string", () => {
    assert.throws(
      () => parseSmsPayload({ to: "+15551234567", body: "" }),
      /renderedPayload\.body/,
    );
  });
});
