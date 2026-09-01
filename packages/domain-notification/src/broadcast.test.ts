import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BroadcastId,
  ChunkId,
  RecipientId,
} from "@notification-system/shared-kernel";
import {
  assertValidChunkSize,
  MAX_RECIPIENTS_PER_CHUNK,
  splitIntoChunks,
} from "./broadcast.js";

const broadcastId = BroadcastId("11111111-1111-1111-1111-111111111111");

function recipients(count: number): RecipientId[] {
  return Array.from({ length: count }, (_, i) => RecipientId(`recipient-${i}`));
}

test("assertValidChunkSize rejects an empty recipient list", () => {
  assert.throws(() => assertValidChunkSize([]));
});

test("assertValidChunkSize rejects more than MAX_RECIPIENTS_PER_CHUNK", () => {
  assert.throws(() =>
    assertValidChunkSize(recipients(MAX_RECIPIENTS_PER_CHUNK + 1)),
  );
});

test("assertValidChunkSize accepts exactly MAX_RECIPIENTS_PER_CHUNK", () => {
  assert.doesNotThrow(() =>
    assertValidChunkSize(recipients(MAX_RECIPIENTS_PER_CHUNK)),
  );
});

test("splitIntoChunks produces a single chunk for a small audience", () => {
  let calls = 0;
  const chunks = splitIntoChunks(broadcastId, recipients(3), () =>
    ChunkId(`chunk-${calls++}`),
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.recipientIds.length, 3);
  assert.equal(chunks[0]!.broadcastId, broadcastId);
});

test("splitIntoChunks caps each chunk at MAX_RECIPIENTS_PER_CHUNK, sized by work not head count evenly", () => {
  const total = MAX_RECIPIENTS_PER_CHUNK * 2 + 1;
  let calls = 0;
  const chunks = splitIntoChunks(broadcastId, recipients(total), () =>
    ChunkId(`chunk-${calls++}`),
  );

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.recipientIds.length, MAX_RECIPIENTS_PER_CHUNK);
  assert.equal(chunks[1]!.recipientIds.length, MAX_RECIPIENTS_PER_CHUNK);
  assert.equal(chunks[2]!.recipientIds.length, 1);
  // Every recipient appears in exactly one chunk.
  const seen = new Set(chunks.flatMap((c) => c.recipientIds));
  assert.equal(seen.size, total);
});

test("splitIntoChunks assigns a distinct id to each chunk via makeChunkId", () => {
  let calls = 0;
  const chunks = splitIntoChunks(
    broadcastId,
    recipients(MAX_RECIPIENTS_PER_CHUNK + 1),
    () => ChunkId(`chunk-${calls++}`),
  );

  assert.deepEqual(
    chunks.map((c) => c.id),
    ["chunk-0", "chunk-1"],
  );
});

test("splitIntoChunks returns no chunks for an empty audience", () => {
  const chunks = splitIntoChunks(broadcastId, [], () => {
    throw new Error("makeChunkId should never be called for an empty audience");
  });

  assert.deepEqual(chunks, []);
});
