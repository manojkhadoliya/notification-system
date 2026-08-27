/**
 * Enforces the one hard boundary rule from ADR 0005 (DDD/hexagonal
 * architecture): a domain-* package (the core, per ADR 0001) must never
 * import an infra-* or providers-* package (the adapters). Adapters depend
 * on domain ports; domain packages don't know adapters exist.
 *
 * This is the static half of a two-layer guardrail — pnpm's strict,
 * non-hoisted node_modules is the runtime half (an undeclared cross-package
 * import fails at require/import time too). See ADR 0001's "Rationale for
 * pnpm specifically."
 */
module.exports = {
  forbidden: [
    {
      name: "domain-must-not-import-adapters",
      comment:
        "packages/domain-* owns ports; packages/infra-*, packages/providers-*, " +
        "and packages/observability implement/support them. The dependency arrow " +
        "only ever points adapter -> domain, never the reverse — see ADR 0005.",
      severity: "error",
      from: {
        path: "^packages/domain-",
      },
      to: {
        path: "^packages/(infra|providers)-|^packages/observability",
      },
    },
    {
      name: "no-circular",
      comment:
        "A dependency cycle between packages defeats the point of splitting them.",
      severity: "error",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: "no-orphans",
      comment:
        "A source file nothing imports and that imports nothing else is either " +
        "dead code or missing from its package's public entrypoint.",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          "(^|/)dist/",
          "(^|/)tsconfig\\.json$",
          "(^|/)(babel|webpack)\\.config\\.(js|cjs|mjs|ts|json)$",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    includeOnly: "^(packages|services)",
    // Deliberately no `tsConfig` option: the root tsconfig.json is a
    // references-only "solution" file (`files: []`), and pointing
    // dependency-cruiser's TS-aware extractor at it hands the extractor an
    // empty program — every import in every file then silently resolves to
    // zero dependencies instead of erroring, which defeats every rule below.
    // Per-package tsconfig.json files exist, but there's no single one that
    // covers the whole `packages`/`services` tree, so this relies on plain
    // node-modules resolution (via pnpm's workspace symlinks) instead, which
    // is sufficient — there are no path aliases to resolve.
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/[^/]+",
      },
    },
  },
};
