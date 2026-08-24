# ADR 0001: Monorepo with pnpm workspaces

## Status
Accepted (superseded npm workspaces — see "Alternatives considered")

## Context
The system is split into several apps (API, per-channel workers) and many
small packages (domain contexts, infra adapters, provider adapters) per the
DDD/hexagonal design (see [`domain-model.md`](../architecture/domain-model.md)).
These need to be developed and versioned together, with fast local
cross-package linking during development, and — critically for the DDD
boundary rule in [ADR 0005](0005-ddd-hexagonal-architecture.md) — a
package must not be able to import another package it hasn't explicitly
declared a dependency on.

## Decision
Single git repo, **pnpm workspaces**, with `apps/` for composition roots
and `packages/` for domain/infra/provider packages. TypeScript project
references keep builds incremental.

## Alternatives considered

- **npm workspaces**: zero extra tooling (built into npm ≥7), which has
  real value for a portfolio repo a reviewer will clone and expect to just
  work. Rejected as the primary choice because its hoisted, flat
  `node_modules` allows **phantom dependencies** — a `domain-*` package
  could accidentally resolve `infra-postgres` at runtime just because it
  happens to be hoisted to the root, even without declaring it as a
  dependency. That directly undercuts the "domain packages cannot import
  infra packages" guarantee this ADR and ADR 0005 both rely on.
- **Turborepo / Nx**: add dependency-graph-aware task orchestration and
  build/test/lint caching. Not worth the added tooling surface at this
  project's scale (~12-18 packages) — this repo is public, so GitHub
  Actions CI minutes are already free/unlimited, and a full workspace
  build is fast enough that skip-unchanged caching isn't solving a real
  pain point yet. Nx's tag-based `enforce-module-boundaries` is a
  genuinely nice alternative to a hand-rolled dependency-cruiser rule, but
  adopting Nx's daemon/generator/plugin surface just for that one feature
  isn't justified for a project meant to showcase architecture
  fundamentals, not build tooling. Revisit if package count or CI time
  grows enough to make caching matter.

## Rationale for pnpm specifically
- **Strict, non-hoisted `node_modules`** makes an undeclared cross-package
  import fail at `require`/`import` time, not just at lint time — a
  second, runtime-level enforcement of the DDD import boundary, on top of
  the Phase 0 dependency-cruiser static check. Belt-and-suspenders on the
  one architectural guarantee ([ADR 0005](0005-ddd-hexagonal-architecture.md))
  the whole package structure is built to demonstrate.
- Faster installs and far less disk usage than npm, from its
  content-addressable store — a minor but free win.
- Workspace protocol (`workspace:*` dependencies, `pnpm-workspace.yaml`) is
  close enough to npm's that this isn't a large departure from the
  ecosystem norm; `apps/*` and `packages/*` still work exactly as
  documented elsewhere.

## Consequences
- `pnpm install` at the root sets up the whole system (contributors need
  pnpm installed — documented in the root README once tooling is
  scaffolded in Phase 0).
- Package boundaries are enforced twice: at install/runtime by pnpm's
  strict linking, and statically by the Phase 0 dependency-cruiser rule —
  a `domain-*` package cannot import `infra-postgres` in either sense
  unless it's added as a declared dependency.
- Trade-off: all packages share one CI pipeline and one repo history
  rather than being independently publishable/versioned — acceptable
  since this isn't published as separate libraries.
- Occasional friction from stricter resolution (a package silently relying
  on a hoisted transitive dependency breaks under pnpm where it wouldn't
  under npm) — treated as a feature here, not a bug, since surfacing that
  exact class of issue is the point.
