import {
  isWithinQuietHours,
  nextQuietHoursEnd,
  type Preference,
  type Recipient,
} from "@notification-system/domain-preferences";
import type { RoutingDecision } from "@notification-system/domain-notification";
import {
  CHANNELS,
  type Channel,
  type NotificationRequestId,
  type Priority,
} from "@notification-system/shared-kernel";

/**
 * `decideChannel`'s result — deliberately narrower than
 * `domain-notification`'s `RoutingDecision`: the `"dispatch"` variant
 * omits `renderedPayload`, since deciding *which* channel to use is pure
 * (no I/O), but producing the rendered content requires an async
 * `TemplateRepository` lookup (see `render-template.ts`). `RouterService`
 * adds `renderedPayload` once it has it, completing the value into a real
 * `RoutingDecision`. The `"deferred"`/`"suppressed"` variants need
 * nothing further, so they're reused verbatim via `Extract` rather than
 * duplicating their field lists by hand.
 */
export type ChannelDecision =
  | {
      readonly kind: "dispatch";
      readonly notificationRequestId: NotificationRequestId;
      readonly channel: Channel;
    }
  | Extract<RoutingDecision, { kind: "deferred" }>
  | Extract<RoutingDecision, { kind: "suppressed" }>;

export interface DecideChannelParams {
  readonly notificationRequestId: NotificationRequestId;
  /** `null` means "no override — pick from the recipient's opted-in
   * channels for this notificationType" (see messaging.md#router). */
  readonly requestedChannel: Channel | null;
  readonly priority: Priority;
  /** `null` means no `Recipient` row exists at all for this id. */
  readonly recipient: Recipient | null;
  /** Every `Preference` for this recipient + notificationType (one per
   * channel that's ever been explicitly set) — from
   * `PreferenceRepository.findPreferences`. */
  readonly preferences: readonly Preference[];
  readonly now: Date;
  /** Caller-computed minute-of-day for `now` — see `isWithinQuietHours`'s
   * doc comment on why this stays a plain number rather than the
   * function assuming a timezone. **Known limitation:** nothing in the
   * domain model stores a recipient's timezone (see `quiet-hours.ts`'s
   * own doc comment: "the router resolves a recipient's timezone and
   * passes an already-localized now in" — there's no way to yet), so
   * `RouterService` currently passes UTC. This package's README flags it
   * as a real, not-silently-assumed gap. */
  readonly nowMinuteOfDay: number;
}

/**
 * Resolves which channel (if any) an event dispatches to right now, per
 * messaging.md#router's steps 2-3. Pure — no I/O, no `TemplateRepository`
 * — so every branch is directly unit-testable (see `routing.test.ts`).
 *
 * Two judgment calls worth knowing about, both because the docs don't
 * pin them down (see this package's README for the full reasoning):
 * - **No `Preference` row for a channel is treated as opted in**
 *   ("opt-out" terminology implies that's the default state, not a
 *   required explicit opt-in).
 * - **Auto-pick order, when no channel is requested, is
 *   `shared-kernel`'s `CHANNELS` declaration order** (`sms`, `push`,
 *   `email`, `in_app`) — not specified anywhere else.
 *
 * One consequence worth knowing, not a bug: `Recipient.hasAddressFor`
 * is unconditionally `true` for `in_app` (there's no external address to
 * be missing), so an auto-picked route can only end up
 * `"suppressed"`/`"opted-out"` if *every* channel including `in_app` is
 * opted out — `"suppressed"`/`"no-address-for-channel"` is only reachable
 * via an *explicit* channel request.
 */
export function decideChannel(params: DecideChannelParams): ChannelDecision {
  const {
    notificationRequestId,
    requestedChannel,
    priority,
    recipient,
    preferences,
    now,
    nowMinuteOfDay,
  } = params;

  if (recipient === null) {
    // Closest fit among RoutingDecision's two suppression reasons —
    // there's definitionally no address to deliver to if the recipient
    // doesn't exist at all.
    return {
      kind: "suppressed",
      notificationRequestId,
      reason: "no-address-for-channel",
    };
  }

  const candidates =
    requestedChannel !== null ? [requestedChannel] : [...CHANNELS];
  let earliestQuietHoursEnd: Date | null = null;
  let anyAddressed = false;

  for (const channel of candidates) {
    if (!recipient.hasAddressFor(channel)) {
      continue;
    }
    anyAddressed = true;

    const preference = preferences.find((p) => p.channel === channel);
    const optedIn = preference?.optedIn ?? true;
    if (!optedIn) {
      continue;
    }

    const quietHours = preference?.quietHours ?? null;
    if (
      priority !== "critical" &&
      quietHours !== null &&
      isWithinQuietHours(nowMinuteOfDay, quietHours)
    ) {
      const dueAt = nextQuietHoursEnd(now, nowMinuteOfDay, quietHours);
      if (earliestQuietHoursEnd === null || dueAt < earliestQuietHoursEnd) {
        earliestQuietHoursEnd = dueAt;
      }
      continue;
    }

    return { kind: "dispatch", notificationRequestId, channel };
  }

  if (earliestQuietHoursEnd !== null) {
    // At least one candidate is only blocked by quiet hours — retry once
    // the earliest of them opens back up. This applies even when a
    // specific channel was requested (a one-element candidate list):
    // an explicit request defers on that channel rather than falling
    // back to a different one, since honoring it as a *request* (per
    // messaging.md#router) means "this channel, when it's available,"
    // not "whichever channel happens to be open right now."
    return {
      kind: "deferred",
      notificationRequestId,
      reason: "quiet-hours",
      dueAt: earliestQuietHoursEnd,
    };
  }
  return {
    kind: "suppressed",
    notificationRequestId,
    reason: anyAddressed ? "opted-out" : "no-address-for-channel",
  };
}
