/**
 * `Preference.quietHoursStart`/`quietHoursEnd` are SQL `time` columns
 * (data-model.md); Prisma represents `@db.Time` as a JS `Date` whose only
 * meaningful parts are hour/minute/second (the date portion is
 * arbitrary — always treated as UTC here to stay host-timezone-independent,
 * since a `time`-only value has no timezone of its own). The domain layer
 * (domain-preferences' `QuietHours`) represents the same value as minutes
 * since midnight — converting between the two is this adapter's job.
 */
export function minutesToPgTime(minuteOfDay: number): Date {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return new Date(Date.UTC(1970, 0, 1, hours, minutes, 0));
}

export function pgTimeToMinutes(time: Date): number {
  return time.getUTCHours() * 60 + time.getUTCMinutes();
}
