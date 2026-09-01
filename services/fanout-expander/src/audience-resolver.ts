import type { PreferenceRepository } from "@notification-system/domain-preferences";
import type { RecipientId, TenantId } from "@notification-system/shared-kernel";

/**
 * Resolves a `BroadcastRequest.audienceDescriptor` into concrete
 * recipient ids — deliberately *not* a `domain-notification` port:
 * `audienceDescriptor` is opaque to that package by design (see
 * `BroadcastRequest`'s own doc comment), and ADR 0011 frames resolution
 * as "using whatever lookup its composition root wires in," i.e. this
 * service's own concern, not a shared domain abstraction.
 */
export interface AudienceResolver {
  resolve(
    tenantId: TenantId,
    audienceDescriptor: Record<string, unknown>,
  ): Promise<RecipientId[]>;
}

/**
 * Phase 1's only supported audience descriptor: `{ "kind":
 * "all_recipients" }`, meaning every `Recipient` row belonging to the
 * broadcast's own `tenantId`. No segmentation/tagging/filter model
 * exists anywhere in this system yet (no `RecipientSegment` concept, no
 * queryable recipient attributes beyond phone/pushToken/email) — this is
 * a deliberate, minimal Phase 1 choice, not an oversight; extending it
 * needs real segmentation data to filter on, which is out of scope here.
 *
 * An unrecognized `kind` throws rather than silently resolving to an
 * empty audience — `FanoutExpanderService` catches this and logs+skips
 * the broadcast (same "data problem, not a transient failure — don't
 * retry forever" treatment `services/router` gives an unresolvable
 * `templateVersionId`), rather than a broadcast partially firing with
 * an obviously-wrong empty audience.
 */
export class PreferenceAudienceResolver implements AudienceResolver {
  constructor(private readonly preferenceRepository: PreferenceRepository) {}

  async resolve(
    tenantId: TenantId,
    audienceDescriptor: Record<string, unknown>,
  ): Promise<RecipientId[]> {
    if (audienceDescriptor.kind !== "all_recipients") {
      throw new Error(
        `Unsupported audienceDescriptor.kind: ${JSON.stringify(audienceDescriptor.kind)} — ` +
          'only "all_recipients" is supported in Phase 1',
      );
    }
    return this.preferenceRepository.findRecipientIdsByTenant(tenantId);
  }
}
