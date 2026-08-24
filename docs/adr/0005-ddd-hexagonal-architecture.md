# ADR 0005: Domain-Driven Design with ports and adapters

## Status
Accepted

## Context
The user explicitly requested that services not be tightly coupled, and
that the system's design adopt Domain-Driven Design concepts rather than a
purely technical (controllers/services/repositories-as-one-blob)
structure. A naive layered structure (one `services/` folder calling
Prisma and amqplib directly) would work for Phase 1 but would make the
later "swap infra without touching business logic" requirement (see ADR
0006) hard to guarantee — nothing would stop business logic from quietly
depending on Prisma types.

## Decision
Organize the system into bounded contexts (`domain-notification`,
`domain-preferences`, `domain-identity`, later `domain-templates`), each
owning its entities, value objects, and **ports** (interface definitions
for anything the domain needs from the outside world — persistence,
messaging, external providers). Infrastructure packages (`infra-*`,
`providers-*`) depend on a domain package to implement its ports. Services
(`services/*` — every one of them a backend process: an HTTP server or a
queue-consumer worker, never a frontend) are thin composition roots that
wire a domain package to concrete adapters via dependency injection and
expose an HTTP/queue entrypoint. Full detail in
[`domain-model.md`](../architecture/domain-model.md).

## Rationale
- **Decoupling**: a domain package importing zero infra packages is a hard
  guarantee (enforceable by lint / dependency-cruiser in Phase 0), not just
  a convention that erodes over time.
- **Testability**: domain services can be unit-tested against in-memory
  fake adapters, with no database or broker running.
- **Swappable infra**: this is the mechanism ADR 0006's local-first /
  free-tier strategy relies on — an adapter can be swapped without
  touching domain code, because domain code never referenced the concrete
  adapter in the first place.

## Consequences
- More upfront structure than a single-service CRUD app — more packages,
  more interfaces to define before writing the first feature. Accepted as
  the point of the exercise: this is a portfolio project meant to
  demonstrate this exact skill.
- Requires discipline to keep `shared-kernel` small — it's tempting to dump
  "common" types there, which would re-couple contexts through the back
  door. `shared-kernel` is scoped to truly universal value objects
  (`TenantId`, `Channel`, `DeliveryStatus`) only.
- The import-direction rule alone doesn't tell you which side new logic
  belongs on — see ["Where does new logic belong?"](../architecture/domain-model.md#where-does-new-logic-belong)
  in `domain-model.md` for the applied test (does it change for a business
  reason or a technology reason?) and worked examples.
