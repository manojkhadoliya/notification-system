import type { Channel, RecipientId } from "@notification-system/shared-kernel";
import type { QuietHours } from "./quiet-hours.js";
import { isWithinQuietHours, minuteOfDay } from "./quiet-hours.js";

export interface PreferenceProps {
  readonly id: string;
  readonly recipientId: RecipientId;
  readonly channel: Channel;
  readonly notificationType: string;
  readonly optedIn: boolean;
  readonly quietHours: QuietHours | null;
  /** Ordered channel fallback list for this notification type, e.g.
   * `[push, sms]`. **Deferred** — reserved column, not read by the router
   * yet. See domain-model.md#recipient-preferences and
   * roadmap.md#future-work. Kept on the entity now so the schema and the
   * domain model don't drift once it is read. */
  readonly fallbackOrder: readonly Channel[] | null;
}

/** Per recipient/channel/notification-type opt-in and quiet-hours rule —
 * see domain-model.md#recipient-preferences. "Consent" in the ubiquitous
 * language is this entity's `optedIn` flag, not a separate persisted
 * concept — data-model.md has no separate Consent table. */
export class Preference {
  private constructor(private readonly props: PreferenceProps) {}

  static create(props: {
    id: string;
    recipientId: RecipientId;
    channel: Channel;
    notificationType: string;
    optedIn: boolean;
    quietHours?: QuietHours | null;
  }): Preference {
    return new Preference({
      ...props,
      quietHours: props.quietHours ?? null,
      fallbackOrder: null,
    });
  }

  static reconstitute(props: PreferenceProps): Preference {
    return new Preference(props);
  }

  get id(): string {
    return this.props.id;
  }

  get recipientId(): RecipientId {
    return this.props.recipientId;
  }

  get channel(): Channel {
    return this.props.channel;
  }

  get notificationType(): string {
    return this.props.notificationType;
  }

  get optedIn(): boolean {
    return this.props.optedIn;
  }

  get quietHours(): QuietHours | null {
    return this.props.quietHours;
  }

  get fallbackOrder(): readonly Channel[] | null {
    return this.props.fallbackOrder;
  }

  /** Would a notification on this channel/type be suppressed right now?
   * `criticalOverridesQuietHours` mirrors the router's rule (see
   * messaging.md#router): a `critical`-priority notification is never
   * deferred for quiet hours, only for an outright opt-out. */
  isSuppressedAt(
    localNow: Date,
    options: { criticalOverridesQuietHours: boolean },
  ): boolean {
    if (!this.props.optedIn) {
      return true;
    }
    if (options.criticalOverridesQuietHours) {
      return false;
    }
    if (this.props.quietHours === null) {
      return false;
    }
    return isWithinQuietHours(minuteOfDay(localNow), this.props.quietHours);
  }
}
