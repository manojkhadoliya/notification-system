import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEmailPayload } from "./email-payload.js";

describe("parseEmailPayload", () => {
  it("accepts a valid payload", () => {
    const result = parseEmailPayload({
      to: "a@example.com",
      subject: "Hi",
      body: "hello",
    });
    assert.deepEqual(result, {
      to: "a@example.com",
      subject: "Hi",
      body: "hello",
    });
  });

  it("throws if `to` is missing", () => {
    assert.throws(
      () => parseEmailPayload({ subject: "Hi", body: "hello" }),
      /renderedPayload\.to/,
    );
  });

  it("throws if `subject` is missing", () => {
    assert.throws(
      () => parseEmailPayload({ to: "a@example.com", body: "hello" }),
      /renderedPayload\.subject/,
    );
  });

  it("throws if `body` is missing", () => {
    assert.throws(
      () => parseEmailPayload({ to: "a@example.com", subject: "Hi" }),
      /renderedPayload\.body/,
    );
  });

  it("throws if `body` is an empty string", () => {
    assert.throws(
      () => parseEmailPayload({ to: "a@example.com", subject: "Hi", body: "" }),
      /renderedPayload\.body/,
    );
  });
});
