import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWithinQuietHours,
  nextQuietHoursEnd,
  quietHoursFromClock,
} from "./quiet-hours.js";

test("same-day window: inside", () => {
  const q = quietHoursFromClock(13, 0, 14, 0); // 13:00-14:00
  assert.equal(isWithinQuietHours(13 * 60 + 30, q), true);
});

test("same-day window: before start and after end are outside", () => {
  const q = quietHoursFromClock(13, 0, 14, 0);
  assert.equal(isWithinQuietHours(12 * 60 + 59, q), false);
  assert.equal(isWithinQuietHours(14 * 60, q), false); // end is exclusive
});

test("same-day window: start is inclusive", () => {
  const q = quietHoursFromClock(13, 0, 14, 0);
  assert.equal(isWithinQuietHours(13 * 60, q), true);
});

test("overnight window (22:00-06:00): late night is inside", () => {
  const q = quietHoursFromClock(22, 0, 6, 0);
  assert.equal(isWithinQuietHours(23 * 60, q), true); // 23:00
  assert.equal(isWithinQuietHours(0, q), true); // midnight
  assert.equal(isWithinQuietHours(5 * 60 + 59, q), true); // 05:59
});

test("overnight window (22:00-06:00): daytime is outside", () => {
  const q = quietHoursFromClock(22, 0, 6, 0);
  assert.equal(isWithinQuietHours(6 * 60, q), false); // end exclusive
  assert.equal(isWithinQuietHours(12 * 60, q), false); // noon
  assert.equal(isWithinQuietHours(21 * 60 + 59, q), false); // 21:59
});

test("overnight window: start is inclusive", () => {
  const q = quietHoursFromClock(22, 0, 6, 0);
  assert.equal(isWithinQuietHours(22 * 60, q), true);
});

test("start === end is treated as the entire day being quiet", () => {
  const q = quietHoursFromClock(9, 0, 9, 0);
  assert.equal(isWithinQuietHours(0, q), true);
  assert.equal(isWithinQuietHours(9 * 60, q), true);
  assert.equal(isWithinQuietHours(23 * 60 + 59, q), true);
});

test("quietHoursFromClock rejects out-of-range values", () => {
  assert.throws(() => quietHoursFromClock(24, 0, 6, 0));
  assert.throws(() => quietHoursFromClock(-1, 0, 6, 0));
  assert.throws(() => quietHoursFromClock(6, 0, 0, 60));
});

test("nextQuietHoursEnd: same-day window ends later today", () => {
  const q = quietHoursFromClock(13, 0, 14, 0); // 13:00-14:00
  const now = new Date("2026-01-01T13:30:00.000Z");
  const dueAt = nextQuietHoursEnd(now, 13 * 60 + 30, q);
  assert.equal(dueAt.toISOString(), "2026-01-01T14:00:00.000Z");
});

test("nextQuietHoursEnd: overnight window, before midnight, ends tomorrow", () => {
  const q = quietHoursFromClock(22, 0, 6, 0); // 22:00-06:00
  const now = new Date("2026-01-01T23:00:00.000Z");
  const dueAt = nextQuietHoursEnd(now, 23 * 60, q);
  assert.equal(dueAt.toISOString(), "2026-01-02T06:00:00.000Z");
});

test("nextQuietHoursEnd: overnight window, after midnight, ends later today", () => {
  const q = quietHoursFromClock(22, 0, 6, 0); // 22:00-06:00
  const now = new Date("2026-01-02T03:00:00.000Z");
  const dueAt = nextQuietHoursEnd(now, 3 * 60, q);
  assert.equal(dueAt.toISOString(), "2026-01-02T06:00:00.000Z");
});

test("nextQuietHoursEnd: all-day window (start === end) exactly on the boundary wraps to tomorrow", () => {
  const q = quietHoursFromClock(9, 0, 9, 0);
  const now = new Date("2026-01-01T09:00:00.000Z");
  const dueAt = nextQuietHoursEnd(now, 9 * 60, q);
  assert.equal(dueAt.toISOString(), "2026-01-02T09:00:00.000Z");
});

test("nextQuietHoursEnd: all-day window ends later the same day when not on the boundary", () => {
  const q = quietHoursFromClock(9, 0, 9, 0);
  const now = new Date("2026-01-01T05:00:00.000Z");
  const dueAt = nextQuietHoursEnd(now, 5 * 60, q);
  assert.equal(dueAt.toISOString(), "2026-01-01T09:00:00.000Z");
});
