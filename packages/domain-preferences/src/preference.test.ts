import { test } from "node:test";
import assert from "node:assert/strict";
import { RecipientId } from "@notification-system/shared-kernel";
import { Preference } from "./preference.js";
import { quietHoursFromClock } from "./quiet-hours.js";

const recipientId = RecipientId("33333333-3333-3333-3333-333333333333");

test("opted-out is always suppressed, quiet hours or not", () => {
  const pref = Preference.create({
    id: "p1",
    recipientId,
    channel: "sms",
    notificationType: "marketing",
    optedIn: false,
  });
  assert.equal(
    pref.isSuppressedAt(new Date(2026, 0, 1, 12, 0), {
      criticalOverridesQuietHours: false,
    }),
    true,
  );
});

test("opted-in with no quiet hours is never suppressed", () => {
  const pref = Preference.create({
    id: "p2",
    recipientId,
    channel: "email",
    notificationType: "billing",
    optedIn: true,
  });
  assert.equal(
    pref.isSuppressedAt(new Date(2026, 0, 1, 3, 0), {
      criticalOverridesQuietHours: false,
    }),
    false,
  );
});

test("opted-in inside quiet hours is suppressed", () => {
  const pref = Preference.create({
    id: "p3",
    recipientId,
    channel: "push",
    notificationType: "reminder",
    optedIn: true,
    quietHours: quietHoursFromClock(22, 0, 6, 0),
  });
  assert.equal(
    pref.isSuppressedAt(new Date(2026, 0, 1, 23, 0), {
      criticalOverridesQuietHours: false,
    }),
    true,
  );
});

test("critical priority overrides quiet hours", () => {
  const pref = Preference.create({
    id: "p4",
    recipientId,
    channel: "push",
    notificationType: "security-alert",
    optedIn: true,
    quietHours: quietHoursFromClock(22, 0, 6, 0),
  });
  assert.equal(
    pref.isSuppressedAt(new Date(2026, 0, 1, 23, 0), {
      criticalOverridesQuietHours: true,
    }),
    false,
  );
});

test("critical priority does not override an opt-out", () => {
  const pref = Preference.create({
    id: "p5",
    recipientId,
    channel: "push",
    notificationType: "security-alert",
    optedIn: false,
  });
  assert.equal(
    pref.isSuppressedAt(new Date(2026, 0, 1, 23, 0), {
      criticalOverridesQuietHours: true,
    }),
    true,
  );
});
