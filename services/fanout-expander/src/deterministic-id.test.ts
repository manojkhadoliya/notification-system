import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicId } from "./deterministic-id.js";

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("produces a UUID-shaped string", () => {
  assert.match(deterministicId("anything"), UUID_SHAPE);
});

test("the same seed always produces the same id", () => {
  assert.equal(
    deterministicId("chunk-1:recipient-1"),
    deterministicId("chunk-1:recipient-1"),
  );
});

test("different seeds produce different ids", () => {
  assert.notEqual(
    deterministicId("chunk-1:recipient-1"),
    deterministicId("chunk-1:recipient-2"),
  );
  assert.notEqual(
    deterministicId("chunk-1:recipient-1"),
    deterministicId("chunk-2:recipient-1"),
  );
});
