# packages/domain-preferences

The **Recipient Preferences** bounded context. Owns `Recipient`,
`Preference`, and `RecipientKey` entities, quiet-hours logic, and defines
the `PreferenceRepository` and `RecipientKeyRepository` ports. Consulted by
`services/router` — not by individual workers — before a message reaches a
channel topic (see
[ADR 0009](../../docs/adr/0009-event-backbone-router.md)).
`RecipientKeyRepository` backs erasure-by-crypto-shredding — designed in
[`data-privacy.md`](../../docs/architecture/data-privacy.md), build
deferred (see [ADR 0013](../../docs/adr/0013-crypto-shredding-erasure.md)).

Zero imports of Prisma or any infra/provider package.

**Implemented by:** `infra-postgres`.

**Delivered in:** Phase 1. Full model in
[`../../docs/architecture/domain-model.md`](../../docs/architecture/domain-model.md).
