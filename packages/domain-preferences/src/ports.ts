import type { Channel, RecipientId } from "@notification-system/shared-kernel";
import type { Preference } from "./preference.js";
import type { Recipient } from "./recipient.js";
import type { RecipientKey } from "./recipient-key.js";

export interface PreferenceRepository {
  findRecipient(id: RecipientId): Promise<Recipient | null>;
  saveRecipient(recipient: Recipient): Promise<void>;

  /** All preferences for one recipient — the router needs the full set to
   * pick a channel when none was requested (see
   * messaging.md#router: "the router picks from the recipient's
   * opted-in channels for that notificationType"), not just one row. */
  findPreferences(
    recipientId: RecipientId,
    notificationType: string,
  ): Promise<Preference[]>;
  findPreference(
    recipientId: RecipientId,
    channel: Channel,
    notificationType: string,
  ): Promise<Preference | null>;
  savePreference(preference: Preference): Promise<void>;
}

/** **Designed now, build deferred** — see data-privacy.md and ADR 0013.
 * Declared here so the shape exists ahead of the Phase-1 crypto-shredding
 * build, not because anything calls it yet. */
export interface RecipientKeyRepository {
  find(recipientId: RecipientId): Promise<RecipientKey | null>;
  getOrCreate(recipientId: RecipientId): Promise<RecipientKey>;
  /** Fails closed for anything still trying to encrypt/decrypt with this
   * recipient's key after this call — see data-privacy.md's fail-closed
   * behavior. */
  destroy(recipientId: RecipientId): Promise<void>;
}
