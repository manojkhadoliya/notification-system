import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePushPayload } from "./push-payload.js";

describe("parsePushPayload", () => {
  it("accepts a valid payload without data", () => {
    const result = parsePushPayload({
      token: "fcm-token",
      title: "Hi",
      body: "hello",
    });
    assert.deepEqual(result, {
      token: "fcm-token",
      title: "Hi",
      body: "hello",
    });
  });

  it("accepts a valid payload with string-valued data", () => {
    const result = parsePushPayload({
      token: "fcm-token",
      title: "Hi",
      body: "hello",
      data: { orderId: "123" },
    });
    assert.deepEqual(result, {
      token: "fcm-token",
      title: "Hi",
      body: "hello",
      data: { orderId: "123" },
    });
  });

  it("throws if `token` is missing", () => {
    assert.throws(
      () => parsePushPayload({ title: "Hi", body: "hello" }),
      /renderedPayload\.token/,
    );
  });

  it("throws if `title` is missing", () => {
    assert.throws(
      () => parsePushPayload({ token: "fcm-token", body: "hello" }),
      /renderedPayload\.title/,
    );
  });

  it("throws if `body` is missing", () => {
    assert.throws(
      () => parsePushPayload({ token: "fcm-token", title: "Hi" }),
      /renderedPayload\.body/,
    );
  });

  it("throws if `data` has a non-string value", () => {
    assert.throws(
      () =>
        parsePushPayload({
          token: "fcm-token",
          title: "Hi",
          body: "hello",
          data: { count: 5 },
        }),
      /renderedPayload\.data\.count must be a string/,
    );
  });

  it("throws if `data` is an array", () => {
    assert.throws(
      () =>
        parsePushPayload({
          token: "fcm-token",
          title: "Hi",
          body: "hello",
          data: ["not-an-object"],
        }),
      /renderedPayload\.data/,
    );
  });
});
