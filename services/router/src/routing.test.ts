import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  Preference,
  Recipient,
  quietHoursFromClock,
} from "@notification-system/domain-preferences";
import {
  NotificationRequestId,
  RecipientId,
  TenantId,
} from "@notification-system/shared-kernel";
import { decideChannel } from "./routing.js";

const notificationRequestId = NotificationRequestId(randomUUID());
const now = new Date("2026-01-01T12:00:00.000Z"); // noon UTC, nowMinuteOfDay 720
const NOON = 12 * 60;

function recipient(
  overrides: {
    phone?: string | null;
    pushToken?: string | null;
    email?: string | null;
  } = {},
) {
  // `overrides.phone ?? default` would be wrong here: `??` also falls
  // through on an explicitly-passed `null` (a test asking for "no
  // address"), not just an omitted key — `!== undefined` is the check
  // that actually distinguishes the two.
  return Recipient.create({
    id: RecipientId(randomUUID()),
    tenantId: TenantId(randomUUID()),
    phone: overrides.phone !== undefined ? overrides.phone : "+15551234567",
    pushToken:
      overrides.pushToken !== undefined ? overrides.pushToken : "push-token",
    email: overrides.email !== undefined ? overrides.email : "a@example.com",
  });
}

function preference(overrides: {
  channel: "sms" | "push" | "email" | "in_app";
  optedIn?: boolean;
  quietHours?: ReturnType<typeof quietHoursFromClock> | null;
}) {
  return Preference.create({
    id: randomUUID(),
    recipientId: RecipientId(randomUUID()),
    channel: overrides.channel,
    notificationType: "order.shipped",
    optedIn: overrides.optedIn ?? true,
    quietHours: overrides.quietHours ?? null,
  });
}

describe("decideChannel", () => {
  it("suppresses (no-address-for-channel) when the recipient doesn't exist", () => {
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: "sms",
      priority: "standard",
      recipient: null,
      preferences: [],
      now,
      nowMinuteOfDay: NOON,
    });
    assert.deepEqual(result, {
      kind: "suppressed",
      notificationRequestId,
      reason: "no-address-for-channel",
    });
  });

  it("dispatches on an explicit channel with no preference row at all (default: opted in)", () => {
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: "sms",
      priority: "standard",
      recipient: recipient(),
      preferences: [],
      now,
      nowMinuteOfDay: NOON,
    });
    assert.deepEqual(result, {
      kind: "dispatch",
      notificationRequestId,
      channel: "sms",
    });
  });

  it("suppresses (no-address-for-channel) when the recipient has no address for the requested channel", () => {
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: "sms",
      priority: "standard",
      recipient: recipient({ phone: null }),
      preferences: [],
      now,
      nowMinuteOfDay: NOON,
    });
    assert.deepEqual(result, {
      kind: "suppressed",
      notificationRequestId,
      reason: "no-address-for-channel",
    });
  });

  it("suppresses (opted-out) when the explicit channel's preference says optedIn: false", () => {
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: "sms",
      priority: "standard",
      recipient: recipient(),
      preferences: [preference({ channel: "sms", optedIn: false })],
      now,
      nowMinuteOfDay: NOON,
    });
    assert.deepEqual(result, {
      kind: "suppressed",
      notificationRequestId,
      reason: "opted-out",
    });
  });

  it("defers (quiet-hours) when inside the window at standard priority", () => {
    const quietHours = quietHoursFromClock(10, 0, 14, 0); // 10:00-14:00, now is noon
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: "sms",
      priority: "standard",
      recipient: recipient(),
      preferences: [preference({ channel: "sms", quietHours })],
      now,
      nowMinuteOfDay: NOON,
    });
    assert.equal(result.kind, "deferred");
    assert.equal(result.kind === "deferred" && result.reason, "quiet-hours");
    assert.equal(
      result.kind === "deferred" && result.dueAt.toISOString(),
      "2026-01-01T14:00:00.000Z",
    );
  });

  it("critical priority overrides quiet hours and dispatches instead", () => {
    const quietHours = quietHoursFromClock(10, 0, 14, 0);
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: "sms",
      priority: "critical",
      recipient: recipient(),
      preferences: [preference({ channel: "sms", quietHours })],
      now,
      nowMinuteOfDay: NOON,
    });
    assert.deepEqual(result, {
      kind: "dispatch",
      notificationRequestId,
      channel: "sms",
    });
  });

  it("critical priority does not override an opt-out", () => {
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: "sms",
      priority: "critical",
      recipient: recipient(),
      preferences: [preference({ channel: "sms", optedIn: false })],
      now,
      nowMinuteOfDay: NOON,
    });
    assert.deepEqual(result, {
      kind: "suppressed",
      notificationRequestId,
      reason: "opted-out",
    });
  });

  it("auto-picks the first eligible channel in CHANNELS order when none is requested", () => {
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: null,
      priority: "standard",
      recipient: recipient(),
      preferences: [preference({ channel: "sms", optedIn: false })], // sms opted out, push is next
      now,
      nowMinuteOfDay: NOON,
    });
    assert.deepEqual(result, {
      kind: "dispatch",
      notificationRequestId,
      channel: "push",
    });
  });

  it("auto-pick skips a channel the recipient has no address for", () => {
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: null,
      priority: "standard",
      recipient: recipient({ phone: null }), // sms has no address, push is next
      preferences: [],
      now,
      nowMinuteOfDay: NOON,
    });
    assert.deepEqual(result, {
      kind: "dispatch",
      notificationRequestId,
      channel: "push",
    });
  });

  it("auto-pick suppresses (opted-out) when every addressed channel is opted out", () => {
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: null,
      priority: "standard",
      recipient: recipient(),
      preferences: [
        preference({ channel: "sms", optedIn: false }),
        preference({ channel: "push", optedIn: false }),
        preference({ channel: "email", optedIn: false }),
        preference({ channel: "in_app", optedIn: false }),
      ],
      now,
      nowMinuteOfDay: NOON,
    });
    assert.deepEqual(result, {
      kind: "suppressed",
      notificationRequestId,
      reason: "opted-out",
    });
  });

  it("auto-pick falls through to in_app when no other channel has an address (in_app always has one)", () => {
    // Recipient.hasAddressFor("in_app") is unconditionally true (see its
    // doc comment: "delivery is 'does this recipient exist,' which it
    // does by construction here") — so an auto-picked route can never
    // actually land on "no-address-for-channel"; in_app is always the
    // last fallback. Only an *explicit* channel request for a
    // no-address channel produces that reason (see the earlier test).
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: null,
      priority: "standard",
      recipient: recipient({ phone: null, pushToken: null, email: null }),
      preferences: [],
      now,
      nowMinuteOfDay: NOON,
    });
    assert.deepEqual(result, {
      kind: "dispatch",
      notificationRequestId,
      channel: "in_app",
    });
  });

  it("auto-pick defers to the earliest quiet-hours end across all blocked candidates", () => {
    const smsWindow = quietHoursFromClock(10, 0, 13, 0); // ends 13:00 — sooner
    const pushWindow = quietHoursFromClock(10, 0, 18, 0); // ends 18:00 — later
    const result = decideChannel({
      notificationRequestId,
      requestedChannel: null,
      priority: "standard",
      recipient: recipient({ email: null, pushToken: "t" }), // only sms/push addressed (+ in_app, opted out below)
      preferences: [
        preference({ channel: "sms", quietHours: smsWindow }),
        preference({ channel: "push", quietHours: pushWindow }),
        preference({ channel: "in_app", optedIn: false }), // otherwise in_app's always-on address would dispatch instead
      ],
      now,
      nowMinuteOfDay: NOON,
    });
    assert.equal(result.kind, "deferred");
    assert.equal(
      result.kind === "deferred" && result.dueAt.toISOString(),
      "2026-01-01T13:00:00.000Z",
    );
  });
});
