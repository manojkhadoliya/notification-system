# packages/domain-templates

The **Templates** bounded context. Owns `Template`/`TemplateVersion`
entities and defines the `TemplateRepository` port. `TemplateVersion` rows
are immutable once published — editing a template creates a new version
rather than mutating an existing one, so a `NotificationRequest` that
referenced a version keeps rendering identically after later edits.

**Contains zero imports of Prisma or any rendering library** — rendering
(Handlebars) happens in the composition root that calls this context, not
inside it; this package only owns the entities and the port (see
[ADR 0005](../../docs/adr/0005-ddd-hexagonal-architecture.md)).

**Implemented by:** `infra-postgres`.

**Delivered in:** Phase 1, built together with the other three channels
(see [ADR 0004](../../docs/adr/0004-channel-rollout.md)). Full model
in [`../../docs/architecture/domain-model.md`](../../docs/architecture/domain-model.md#templates).
