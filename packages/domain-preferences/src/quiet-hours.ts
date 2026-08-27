/**
 * A recurring daily time window during which non-urgent notifications are
 * suppressed — see domain-model.md#recipient-preferences. Stored as
 * `Preference.quiet_hours_start`/`quiet_hours_end` (SQL `time`, no date —
 * see data-model.md), so this is a time-of-day, not a fixed instant.
 *
 * `start`/`end` are minutes since local midnight (`0..1439`). Interpreting
 * "local" (which timezone) is the caller's job — the router resolves a
 * recipient's timezone and passes an already-localized `now` in.
 */
export interface QuietHours {
  readonly startMinute: number;
  readonly endMinute: number;
}

function assertValidClock(hour: number, minute: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Quiet-hours hour must be an integer 0-23, got ${hour}`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(
      `Quiet-hours minute must be an integer 0-59, got ${minute}`,
    );
  }
}

export function quietHoursFromClock(
  startHour: number,
  startMinute: number,
  endHour: number,
  endMinute: number,
): QuietHours {
  // Validate hour/minute components individually — validating only the
  // combined total (hour*60+minute) lets an out-of-range minute like `:60`
  // silently wrap into another valid total (e.g. 0:60 == 1:00) instead of
  // being rejected.
  assertValidClock(startHour, startMinute);
  assertValidClock(endHour, endMinute);
  return {
    startMinute: startHour * 60 + startMinute,
    endMinute: endHour * 60 + endMinute,
  };
}

/**
 * Is `atMinuteOfDay` (0..1439, already localized to the recipient's
 * timezone) inside the window? Handles the overnight case correctly —
 * e.g. `22:00`-`06:00` spans midnight, so "inside" means
 * `>= start OR < end`, not `>= start AND < end` (which is only correct
 * when the window doesn't cross midnight).
 *
 * `start === end` is treated as "quiet hours cover the entire day" (an
 * explicit, if unusual, tenant choice) rather than "no quiet hours" — an
 * empty window would need `start === null` at the `Preference` level,
 * which is a different, already-nullable case (see quiet_hours_start/end
 * in data-model.md).
 */
export function isWithinQuietHours(
  atMinuteOfDay: number,
  quietHours: QuietHours,
): boolean {
  const { startMinute, endMinute } = quietHours;
  if (startMinute === endMinute) {
    return true;
  }
  if (startMinute < endMinute) {
    // Same-day window, e.g. 13:00-14:00.
    return atMinuteOfDay >= startMinute && atMinuteOfDay < endMinute;
  }
  // Overnight window, e.g. 22:00-06:00.
  return atMinuteOfDay >= startMinute || atMinuteOfDay < endMinute;
}

/** Minutes since local midnight for a `Date` already representing the
 * recipient's local time (e.g. via `Intl`-based conversion upstream). */
export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}
