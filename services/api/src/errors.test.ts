import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  badRequest,
  conflict,
  notFound,
  tooManyRequests,
  unauthorized,
} from "./errors.js";

describe("error helpers", () => {
  it("unauthorized is a 401 with a default message", () => {
    const err = unauthorized();
    assert.ok(err instanceof ApiError);
    assert.equal(err.statusCode, 401);
    assert.equal(err.code, "unauthorized");
    assert.equal(err.message, "invalid or missing API key");
  });

  it("notFound is a 404 with a default message", () => {
    const err = notFound();
    assert.equal(err.statusCode, 404);
    assert.equal(err.code, "not_found");
  });

  it("conflict is a 409 requiring an explicit message", () => {
    const err = conflict("idempotency key reused with a different payload");
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, "conflict");
    assert.equal(
      err.message,
      "idempotency key reused with a different payload",
    );
  });

  it("tooManyRequests is a 429 with a default message", () => {
    const err = tooManyRequests();
    assert.equal(err.statusCode, 429);
    assert.equal(err.code, "rate_limited");
  });

  it("badRequest is a 400 requiring an explicit message", () => {
    const err = badRequest("recipientId is required");
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, "bad_request");
    assert.equal(err.message, "recipientId is required");
  });
});
