import type { RecipientId } from "@notification-system/shared-kernel";

/**
 * A per-recipient encryption key protecting personal-data fields on the
 * long-retention event log; destroying it is how an erasure request is
 * honored without editing the log itself. **Designed now, build
 * deferred** — see data-privacy.md and ADR 0013. Modeled here (a plain
 * shape, not a behavior-bearing entity yet) so the port signature below
 * exists and the schema/domain model don't drift once this is built.
 */
export interface RecipientKey {
  readonly recipientId: RecipientId;
  /** Envelope-encrypted per-recipient key — see data-privacy.md. Opaque to
   * the domain layer; only the crypto-shredding adapter interprets it. */
  readonly dataKeyCiphertext: Uint8Array;
  readonly createdAt: Date;
  readonly destroyedAt: Date | null;
}
