import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stepTokenBucket } from "./token-bucket.js";

describe("stepTokenBucket", () => {
  it("starts full for a key never seen before and allows the first call", () => {
    const result = stepTokenBucket(
      null,
      { capacity: 10, refillPerSecond: 1 },
      1_000,
    );
    assert.equal(result.allowed, true);
    assert.equal(result.state.tokens, 9);
  });

  it("denies once the bucket is empty, without going negative", () => {
    const result = stepTokenBucket(
      { tokens: 0, updatedAtMs: 1_000 },
      { capacity: 10, refillPerSecond: 1 },
      1_000,
    );
    assert.equal(result.allowed, false);
    assert.equal(result.state.tokens, 0);
  });

  it("refills proportionally to elapsed time", () => {
    const result = stepTokenBucket(
      { tokens: 0, updatedAtMs: 1_000 },
      { capacity: 10, refillPerSecond: 2 },
      2_000, // 1s elapsed * 2/s = 2 tokens refilled
    );
    assert.equal(result.allowed, true);
    assert.equal(result.state.tokens, 1); // 2 refilled, 1 consumed
  });

  it("clamps refilled tokens at capacity even after a long idle gap", () => {
    const result = stepTokenBucket(
      { tokens: 0, updatedAtMs: 1_000 },
      { capacity: 5, refillPerSecond: 100 },
      1_000_000, // way more than enough elapsed time to overflow capacity
    );
    assert.equal(result.allowed, true);
    assert.equal(result.state.tokens, 4); // capacity(5) - 1 consumed, not more
  });

  it("still credits fractional refill on a denied call", () => {
    const result = stepTokenBucket(
      { tokens: 0.2, updatedAtMs: 1_000 },
      { capacity: 10, refillPerSecond: 1 },
      1_500, // 0.5s elapsed * 1/s = 0.5 refilled -> 0.7 total, still < 1
    );
    assert.equal(result.allowed, false);
    assert.ok(Math.abs(result.state.tokens - 0.7) < 1e-9);
    assert.equal(result.state.updatedAtMs, 1_500);
  });

  it("treats a zero or negative elapsed time as no refill", () => {
    const result = stepTokenBucket(
      { tokens: 0, updatedAtMs: 5_000 },
      { capacity: 10, refillPerSecond: 1 },
      4_000, // clock moved backwards relative to the stored timestamp
    );
    assert.equal(result.allowed, false);
    assert.equal(result.state.tokens, 0);
  });
});
