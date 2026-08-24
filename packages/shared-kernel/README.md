# packages/shared-kernel

Minimal set of value objects genuinely shared across every bounded context
— `TenantId`, `Channel`, `DeliveryStatus` and similarly universal enums/
types. Deliberately kept as small as possible: it's tempting to dump
"common" types here, but doing so re-couples contexts through the back
door and defeats the point of splitting them (see
[ADR 0005](../../docs/adr/0005-ddd-hexagonal-architecture.md)). If a type
is meaningful to only one or two contexts, it belongs in that context's
`domain-*` package instead, referenced by id from the others.

**Delivered in:** Phase 1, grown only as strictly needed thereafter.
