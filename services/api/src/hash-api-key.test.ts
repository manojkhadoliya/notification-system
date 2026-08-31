import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashApiKey } from "./hash-api-key.js";

describe("hashApiKey", () => {
  it("is deterministic", () => {
    assert.equal(hashApiKey("my-secret-key"), hashApiKey("my-secret-key"));
  });

  it("produces different digests for different inputs", () => {
    assert.notEqual(hashApiKey("key-a"), hashApiKey("key-b"));
  });

  it("matches a plain SHA-256 hex digest", () => {
    const expected = createHash("sha256")
      .update("my-secret-key", "utf8")
      .digest("hex");
    assert.equal(hashApiKey("my-secret-key"), expected);
  });

  it("produces a 64-character lowercase hex string", () => {
    const digest = hashApiKey("anything");
    assert.match(digest, /^[0-9a-f]{64}$/);
  });
});
