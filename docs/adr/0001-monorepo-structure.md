# ADR 0001: Monorepo with npm workspaces

## Status
Accepted

## Context
The system is split into several apps (API, per-channel workers) and many
small packages (domain contexts, infra adapters, provider adapters) per the
DDD/hexagonal design (see [`domain-model.md`](../architecture/domain-model.md)).
These need to be developed and versioned together, with fast local
cross-package linking during development.

## Decision
Single git repo, npm workspaces, with `apps/` for composition roots and
`packages/` for domain/infra/provider packages. TypeScript project
references keep builds incremental and enforce that a package can only
import what it declares a dependency on.

## Consequences
- One `npm install` at the root sets up the whole system.
- Package boundaries are enforced by workspace dependency declarations, not
  just convention — a `domain-*` package literally cannot import
  `infra-postgres` unless it's added as a dependency, which a Phase 0 lint
  rule additionally forbids.
- Trade-off: all packages share one CI pipeline and one repo history rather
  than being independently publishable/versioned — acceptable since this
  isn't published as separate libraries.
