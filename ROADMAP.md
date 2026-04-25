# Lexen — Roadmap

## Completed

### Type-checker-based dynamic resolution (Path A) — shipped

Lexen now ships a TypeScript type-checker resolver behind a config flag:
`"resolver": "typechecker"` in `i18n.config.json`. It resolves the shapes
described below — `t(item.labelKey)`, `useTranslations(CONFIG[k].ns)`,
template holes whose type is a string-literal union — plus caller-passed
`t` props (`propFlow`). Default is still `"ast"` for zero-config projects.

Use `pnpm lexen extract --compare-resolvers` to diff AST vs typechecker
output before flipping the default, and `pnpm lexen:test` to run the
fixture suite that exercises every supported pattern.

Once flipped, `preserve` entries that the resolver now covers are flagged
by `lexen check` as redundant (and can be deleted). Preserve stays as an
escape hatch for truly-runtime keys (`t(fn())`, `t(api.x())`).

---

## Dynamic-call resolution (in-place of `preserve` directives) — historical notes

Today lexen has a strict static-extraction limit: `t(variable)` and
`useTranslations(variable)` are invisible. The workaround is the `preserve`
config directive (see README §"What Lexen can't see" fix 3), which
trades mechanical correctness for developer diligence — if a new dynamic
key isn't added to `preserve`, `--clean` will silently prune it and the
UI will render `MISSING_MESSAGE` at runtime.

### Goal

Teach lexen to resolve **config-driven** dynamic calls automatically using
the TypeScript type-checker, eliminating most manual `preserve` entries.

### Scope (what to support)

**In-scope** — static config arrays / object properties where the type
system can prove the possible values:

```ts
// Array of literals — enumerate every labelKey
const items = [
    { labelKey: 'nav.home', ... },
    { labelKey: 'nav.audit', ... },
];
items.map(item => t(item.labelKey));
// lexen should emit: uses of nav.home, nav.audit in this namespace

// Config object keyed by enum / union
const ROLE_STATS: Record<Role, { translationNamespace: string }> = {
    admin: { translationNamespace: 'widget.dashboard.academyStats' },
    owner: { translationNamespace: 'widget.dashboard.ownerStats' },
};
const t = useTranslations(ROLE_STATS[role].translationNamespace);
// lexen should emit: uses under widget.dashboard.academyStats + widget.dashboard.ownerStats
```

**Out-of-scope** — impossible without executing the code:

```ts
t(getLabel());              // function return value
t(api.fetchLabel());        // I/O
t(cond ? dynamicA : dynamicB);  // non-literal ternary branches
```

For these, `preserve` directives remain the escape hatch.

### Implementation sketch

1. **Use the TypeScript compiler's type-checker**, not just the AST. `ts.createProgram`
   with a proper `tsconfig.json` gives access to `getSymbolAtLocation`, `getTypeAtLocation`,
   and literal-type resolution.

2. **For `t(<expr>)` where `<expr>` is not a literal**: walk the expression:
   - `identifier` → resolve symbol → find declaration → extract literal initializer if `const`.
   - `x.y` (property access) → resolve `x`'s type → if it's a literal string type (or union of string literals), emit each.
   - `arr[i]` / `items.map(i => t(i.x))` → resolve element type; same rules.

3. **For `useTranslations(<expr>)`**: same resolution, but the result is a **namespace**
   (or set of possible namespaces). Currently `extractAll` extracts keys per-namespace; to
   support multiple resolved namespaces at one call site, extend the binding map
   (`varToNamespace: Map<string, string>`) to `Map<string, string[]>`.

4. **Caller-passed `t` prop**:
   ```ts
   function TransportCard({t}: {t: (key: string) => string}) { t('X'); }
   // parent: <TransportCard t={someT} />
   ```
   Lexen today treats the inner `t('X')` as untracked (no binding). With type-checker
   help, lexen could detect that `someT` came from a specific `useTranslations(ns)` and
   attribute `'X'` to `ns`. Handles the TransportRosterTab-style patterns we hit in
   Phase 2c-mixed without renaming props.

### Effort estimate

~1–2k LOC, 2–3 focused days. The bulk is in `extract.ts`, extending `callToNamespace`
and `collectTranslationCall`. The validator and sync don't change — they operate on
the already-emitted `namespaceKeys` map.

### Rollout

1. Land the implementation behind a feature flag (`"resolver": "ast" | "typechecker"` in
   config, default `ast`).
2. Run both resolvers in parallel for a release; compare outputs.
3. When typechecker resolver is at parity + covers more cases, flip default.
4. Deprecate manual `preserve` entries that the resolver now handles. The `preserve`
   directive itself stays — there are always truly-dynamic cases that need it.

### Why not do this now

Path B (`preserve` directive) covers our current codebase's ~5 dynamic patterns for
~100 LOC. Path A (this roadmap item) is 10–20× the engineering for coverage we already
have via `preserve`. Reasonable to pursue once lexen has 3+ consumer projects and the
per-project `preserve` config gets annoying.

### Related ideas (smaller, not blocking)

- **`// @lexen-preserve ns.prefix.*` JSDoc directive** — in-source equivalent of the
  config `preserve` entry, scoped to a specific file or call site. Useful when a
  dynamic pattern is localized to one component and shouldn't bloat the global config.

- **`preserve` validation on check** — warn if a `preserve` entry covers keys that
  are already statically visible (redundant), or covers a namespace that doesn't exist.
  Avoids stale config as code changes.

- **CI integration** — built-in `pnpm lexen check --format=junit` / `--format=github`
  output for nicer error surfaces in CI logs.

---

## Known regressions to investigate (post-Phase-2c-mixed)

These are runtime `MISSING_MESSAGE` errors surfaced during manual dev testing
after all four 2c-mixed batches merged. Most are cases where a static key
**should** have been seen by lexen but wasn't moved correctly, OR a call
site is pointing at the wrong namespace after the split.

### `GroupPlayersTableDesktop.tsx` — many missing groups/common keys

File: `web/app/src/widgets/groups/GroupDetails/...` (exact path to confirm).

Failing lookups:
- `groups.title`, `groups.stats.totalPlayers`, `groups.add`, `groups.searchPlaceholder`
- `groups.filterByCategory`, `groups.filterByPosition`
- `groups.statusAll`, `groups.statusActive`, `groups.statusInactive`
- `groups.columns.player`, `groups.columns.number`, `groups.columns.birthYear`, `groups.columns.category`, `groups.columns.joined`, `groups.columns.status`
- `groups.noPosition`, `groups.playerCategory.regular`, `groups.joinDate`, `groups.active`, `groups.deactivate`
- `common.selectAll`, `common.select`, `common.actions.delete`

Hypotheses:
1. The widget uses `useTranslations('groups')` but the keys were moved to
   `widget.groups` during Batch A (which migrated `groups.dashboard.*` →
   `widget.groups.dashboard.*`). Likely the binding should be `widget.groups`
   or split into two bindings.
2. The `common.selectAll`, `common.select`, `common.actions.delete` keys were
   pruned in Phase 3a because no other static call referenced them — need to
   restore to global messages/common or add to `preserve["common"]`.

Investigation steps:
1. Read the file and enumerate every `t('X')` call.
2. For each, check whether `X` exists in `features/groups/locales/ru.json` or
   `widgets/groups/locales/ru.json`.
3. Route the binding accordingly (two bindings if mixed). Follow the
   transport pilot's pattern (commit 504a8f73).
4. Restore `common.selectAll`, `common.select`, `common.actions.delete` to
   `i18n/messages/{ru,kk}.json` under `common` if they were pruned but are
   legitimately used.

### Other suspected regressions (not yet reproduced)

Areas to sweep with `pnpm dev` once backend is up:
- `features/transport/components/TransportsList.tsx` — uses `actions.*`,
  `status.*`, `table.*` which should have stayed in feature. Verify.
- `src/widgets/groups/**/PaymentHistoryDrawer.tsx` — cross-namespace
  payments+groups file. Verify bindings after 2c-mixed.
- Any feature that Batch D SKIPPED (auth, schedule, news) should have no
  regressions, but worth a quick pass.

### Prevention for future migrations

- Add `preserve` entries before running `extract --clean`, not after.
- When splitting a mixed feature, verify every consuming file's bindings in
  the same PR — don't rely on lexen check alone (it misses dynamic
  namespace arguments and the `common.*` direct-JSON-import cases).
- Consider Path A (above) to eliminate this class of regression mechanically.
