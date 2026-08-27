import { test } from "node:test";
import assert from "node:assert/strict";
import { RetryPolicy } from "./retry-policy.js";

test("attempt 1 has no delay", () => {
  assert.equal(new RetryPolicy().delayBeforeAttempt(1), 0);
});

test("attempts 2-4 follow the 30s/5m/30m ladder", () => {
  const policy = new RetryPolicy();
  assert.equal(policy.delayBeforeAttempt(2), 30_000);
  assert.equal(policy.delayBeforeAttempt(3), 300_000);
  assert.equal(policy.delayBeforeAttempt(4), 1_800_000);
});

test("attempt 5 is exhausted — no further delay", () => {
  assert.equal(new RetryPolicy().delayBeforeAttempt(5), null);
});

test("maxAttempts is 4 (1 initial + 3 retry tiers)", () => {
  assert.equal(RetryPolicy.maxAttempts, 4);
});

test("isExhausted matches delayBeforeAttempt's null boundary", () => {
  const policy = new RetryPolicy();
  for (let attempt = 1; attempt <= 6; attempt++) {
    assert.equal(
      policy.isExhausted(attempt),
      policy.delayBeforeAttempt(attempt) === null,
      `attempt ${attempt}`,
    );
  }
});

test("rejects a non-positive or non-integer attempt number", () => {
  const policy = new RetryPolicy();
  assert.throws(() => policy.delayBeforeAttempt(0));
  assert.throws(() => policy.delayBeforeAttempt(-1));
  assert.throws(() => policy.delayBeforeAttempt(1.5));
});
