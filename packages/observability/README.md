# packages/observability

Shared OpenTelemetry bootstrap. Exports `startTracing({ serviceName })`,
called once at the top of every `services/*` entrypoint, before any
instrumented module (Kafka client, `pg`, Redis, HTTP) is imported —
auto-instrumentation patches modules at `require`/`import` time, so import
order matters.

Traces export via OTLP/HTTP to the `jaeger` container in
`infra/docker-compose.yml` (UI on `http://localhost:16686`). Metrics and
logs are out of scope here — see
[`docs/roadmap.md`](../../docs/roadmap.md)'s reliability-polish items for
Prometheus metrics as a separate, later piece.

Unlike the `domain-*`/`infra-*`/`providers-*` packages, this one isn't
DDD-context-shaped — it's a cross-cutting composition-root concern (every
`services/*` process wires it identically), so it depends on nothing in
`packages/domain-*` and nothing in `packages/domain-*` may depend on it
(same direction as any other adapter — see
[ADR 0005](../../docs/adr/0005-ddd-hexagonal-architecture.md)).

**Delivered in:** Phase 0 — unlike the rest of `packages/*`, this one is
real working code from scaffolding onward rather than a Phase 1 stub,
since a tracing bootstrap has no domain model to wait on.
