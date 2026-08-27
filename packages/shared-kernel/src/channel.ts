/** See domain-model.md#notification-delivery-core-domain. */
export const CHANNELS = ["sms", "push", "email", "in_app"] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

/**
 * The three event-backbone lanes a notification is produced onto — see
 * messaging.md#topic-layout. Distinct from `Channel`: priority is decided
 * by the caller at ingest (how urgent is this notification), channel is
 * decided by the router (which medium delivers it).
 */
export const PRIORITIES = ["critical", "standard", "bulk"] as const;
export type Priority = (typeof PRIORITIES)[number];

export function isPriority(value: string): value is Priority {
  return (PRIORITIES as readonly string[]).includes(value);
}
