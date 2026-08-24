# packages/domain-preferences

The **Recipient Preferences** bounded context. Owns `Recipient` and
`Preference` entities, quiet-hours logic, and defines the
`PreferenceRepository` port. Consulted by `domain-notification`'s dispatch
service before every send.

Zero imports of Prisma or any infra/provider package.

**Implemented by:** `infra-postgres`.

**Delivered in:** Phase 1. Full model in
[`../../docs/architecture/domain-model.md`](../../docs/architecture/domain-model.md).
