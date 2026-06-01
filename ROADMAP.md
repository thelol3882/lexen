# Lexen — Roadmap

## Completed / Shipped

### Type-checker-based dynamic resolution — shipped

Lexen ships a TypeScript type-checker resolver behind a config flag:
`"resolver": "typechecker"` in `i18n.config.json`. It resolves dynamic
shapes — `t(item.labelKey)`, `useTranslations(CONFIG[k].ns)`, template holes
whose type is a string-literal union — plus caller-passed `t` props
(`propFlow`). Default is still `"ast"` for zero-config projects.

Use `pnpm lexen extract --compare-resolvers` to diff AST vs typechecker
output before flipping, and `pnpm lexen:test` to run the fixture suite that
exercises every supported pattern.

Once flipped, `preserve` entries the resolver now covers are flagged by
`lexen check` as redundant (and can be deleted). `preserve` stays as an
escape hatch for truly-runtime keys.

### `calls` config — custom call-extractor — shipped

Builder functions like `buildMetadata({namespace, key})` are recognized as
key sources. Configure them via `calls` in `i18n.config.json`:

```json
"calls": [
  {
    "callee": "buildMetadata",
    "package": "@/utils/meta",
    "namespace": {"prop": "namespace", "default": "common"},
    "keys": ["{key}"],
    "defaults": {"key": "title"}
  }
]
```

Each entry specifies callee name(s), an optional import-source filter, the
argument index, how to extract the namespace from the object argument, and
key templates whose `${propName}` holes are expanded via literal resolution.
See `CallExtractorConfig` in `types.ts`.

### Safe clean + `--force` — shipped

`extract --clean` will not prune a namespace that has unresolved dynamic
keys. If a `useTranslations(<expr>)` call can't be attributed to a namespace,
or an unattributable `t(<expr>)` is present, the clean is blocked globally
until `--force` is passed. This is the **"lexen never silently loses a key"**
guarantee.

`--force` overrides all protections and prunes everything `--clean` would
normally skip.

### `lexen lint` — rules-violation diagnostics — shipped

```bash
pnpm lexen lint [feature] [--naming] [--format=human|github|json]
```

Report-only rules diagnostics. Each violation is pinned to `file:line:col`
with a fix hint, grouped by rule. Default run surfaces the runtime-risk rules:

| Rule | What it flags | How |
|---|---|---|
| 1 | dynamic `useTranslations` namespace | unresolved call → rule 1 |
| 2 | unresolved `t()` key | unresolved `t` / configured-call arg |
| 4 | `t` passed as prop | propFlow trace failure |
| 5 | invalid namespace | `lexen check` rule; also in lint |
| 9 | placeholder drift | ICU variable mismatch across locales |

Rule 7 (camelCase key naming) is opt-in via `--naming` — it's a style
preference and can produce many findings on large codebases.

Exit 1 if any violations are found.

### `--format=human|github|json` on `check` and `lint` — shipped

`--format=github` emits `::error file=…,line=…::` annotations for CI.
`--format=json` emits a structured report/violation array.

**Important:** machine formats must be invoked as `pnpm --silent lexen …`
(or the `lexen` bin directly) — plain `pnpm` prints a lifecycle banner to
stdout that corrupts piped JSON.

### `check --strict` — shipped

```bash
pnpm lexen check --strict
```

Folds the lint correctness-rules check into `check`. One CI command gates
both locale-sync *and* rules violations. Exit 1 on either.

### `--quiet` on `extract` / `check` — shipped

Suppresses per-namespace "synced" detail lines. Only problems and the summary
are printed. Useful when running on a large codebase where the happy-path
output is noise.

### Config JSON Schema — shipped

`schema/i18n.config.schema.json` ships with the package. Configs can opt in
to IDE validation and autocomplete with:

```json
{
  "$schema": "./node_modules/@thelol3882/lexen/schema/i18n.config.schema.json"
}
```

`lexen init` scaffolds the `$schema` line automatically (all presets include
it).

---

## In Progress / Planned

### `lexen lint --fix` (ruff-style) — planned

Modelled on `ruff check --fix`: auto-apply only **SAFE** fixes (behavior-
preserving, no data loss risk). UNSAFE fixes are **not** applied by `--fix`;
they're reported with a marker and require explicit `--unsafe-fixes`.

Per-rule classification:

| Rule | Fix class | Notes |
|---|---|---|
| 9 — placeholder drift | Report-only | No mechanical fix; translator must reconcile |
| 7 — camelCase rename | **UNSAFE** | Cross-file codemod: rewrite `t('…')` call + locale JSON key + every other reference. Risk of missing dynamic or aliased refs. |
| 3 — key in data → call-site | **UNSAFE** | Structural refactor; semantics may change |
| 5 — invalid namespace | Report-only | Requires manual wiring of a new `locales/` dir |
| 1/2/4 — unresolved calls | Report-only | No mechanical fix; depends on code intent |
| locale sort / format normalization | **SAFE** | Already handled by `lexen sort` |

The safe auto-fix set is small — `lint --fix` will primarily be a reporter.
The value of `--unsafe-fixes` is having a guided codemod path for bulk
renames (rule 7) that the developer reviews before committing.

### Incremental program + `--watch` — planned

Re-use the TypeScript compiler's incremental build to avoid reparsing the
entire project on each run. Enables a `--watch` mode that re-extracts on file
save and streams `lexen lint` findings to the terminal in real time — useful
during active development without the CI round-trip.

---

## Background / Historical Notes

### Dynamic-call resolution (Path A)

The historical notes below describe the design path that led to the
typechecker resolver (now shipped). They document the scope, implementation
sketch, and rollout plan as originally written — kept for reference.

#### Scope

**In-scope** — static config arrays / object properties where the type system
can prove possible values:

```ts
// Array of literals — enumerate every labelKey
const items = [
    {labelKey: 'nav.home', ...},
    {labelKey: 'nav.audit', ...},
];
items.map(item => t(item.labelKey));
// emits: nav.home, nav.audit

// Config object keyed by union
const ROLE_STATS: Record<Role, {translationNamespace: string}> = {
    admin: {translationNamespace: 'widget.dashboard.academyStats'},
    owner: {translationNamespace: 'widget.dashboard.ownerStats'},
};
const t = useTranslations(ROLE_STATS[role].translationNamespace);
```

**Out-of-scope** — impossible without executing the code:

```ts
t(getLabel());          // function return value
t(api.fetchLabel());    // I/O
```

For these, `preserve` directives remain the escape hatch.

#### Rollout (completed)

1. Implementation behind `"resolver": "ast" | "typechecker"` in config.
2. Both resolvers available in parallel via `--compare-resolvers`.
3. Typechecker is at parity + covers more cases; default remains `ast` for
   zero-config projects.
4. `preserve` entries the resolver now covers are flagged as redundant by
   `lexen check`. The `preserve` directive itself stays for truly-dynamic
   cases.

---

### Related ideas

- **`// @lexen-preserve ns.prefix.*` JSDoc directive** — in-source equivalent
  of the config `preserve` entry, scoped to a specific file or call site.
  Useful when a dynamic pattern is localized to one component and shouldn't
  bloat the global config.

- **`preserve` validation on check** — warn if a `preserve` entry covers keys
  that are already statically visible (redundant), or covers a namespace that
  doesn't exist. Avoids stale config as code changes. (Partially shipped:
  `lexen check` already reports redundant and invalid preserve entries.)
