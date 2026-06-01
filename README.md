# Lexen

Config-driven translation extraction, validation, and sorting. Built on the TypeScript compiler API — every key comes from a real AST node with a real source position.

A Node CLI that reads `i18n.config.json` and reconciles your locale files against what's actually used in code. Framework-agnostic — works with `next-intl`, `react-i18next`, or any hook-based translation API you configure.

## Status

I built lexen for my own projects and publish it as a convenience for anyone who finds it useful. It's not a community-driven package — issue triage, PR review, feature requests, and backwards-compat guarantees are best-effort at most. Releases happen when my own work needs them.

If lexen does what you need: great, use it. If you need active maintenance or features I haven't built, fork it (MIT) — that's probably the right call. Pin to an exact version if you depend on it in production.

## Install

```bash
pnpm add -D @thelol3882/lexen
```

`lexen` ships its own `typescript` and `glob` deps; no peer deps to satisfy. The bin command is `lexen` (unscoped) regardless of the install path.

## Quick start

```bash
pnpm exec lexen init                # scaffold i18n.config.json (next-intl preset)
pnpm exec lexen init --preset=react-i18next
pnpm exec lexen extract             # populate locale files with empty strings for new keys
pnpm exec lexen check               # CI mode: fail on drift
```

Add a script for ergonomics:

```json
{
  "scripts": {
    "i18n": "lexen"
  }
}
```

Then `pnpm i18n extract`, `pnpm i18n check`, etc.

## Commands

| Command | What it does |
|---|---|
| `lexen extract` | Scan `src/`, add missing keys (empty `""`) to every locale file. |
| `lexen extract --clean` | Same, but also remove keys that exist on disk but not in code (safe — see below). |
| `lexen extract --clean --force` | Prune all unused keys, even in namespaces with unresolved dynamic calls. |
| `lexen extract --quiet` | Suppress per-namespace "synced" detail; show only problems + summary. |
| `lexen extract <feature>` | Restrict to one namespace. |
| `lexen extract --compare-resolvers` | Run both resolvers side-by-side and diff their output. Useful before flipping `resolver` to `typechecker`. |
| `lexen check` | CI mode — fail (exit 1) on missing / unused / invalid-namespace drift. |
| `lexen check --strict` | Same, plus fold in `lexen lint` correctness rules. One command for CI. |
| `lexen check --quiet` | Suppress per-namespace "synced" detail; show only failures + summary. |
| `lexen check --format=human\|github\|json` | Output format for CI integrations (see below). |
| `lexen lint` | Rules-violation diagnostics — `file:line:col` + fix hint, grouped by rule. Exit 1 if any. |
| `lexen lint --naming` | Include rule 7 (camelCase key naming) in the report. |
| `lexen lint --format=human\|github\|json` | Output format. |
| `lexen sort` | Normalize key order in every locale file (deep-sort, alphabetical). |
| `lexen init` | Scaffold `i18n.config.json` from a preset (`--preset`, `--force`). |

All commands print per-locale translation coverage stats at the end.

## Namespace conventions

Three layers, three scopes:

| Scope | Call site | Lives at |
|---|---|---|
| **Global** | `useTranslations('common')` | `src/i18n/messages/{locale}.json` under `common` key |
| **Feature** | `useTranslations('<feature>')` | `src/features/<feature>/locales/{locale}.json` |
| **Widget** | `useTranslations('widget.<name>')` | `src/widgets/<name>/locales/{locale}.json` |

All three are auto-discovered — drop a `locales/` dir in a feature or widget and it loads at runtime and gets picked up by the extractor on the next run. No manual registration.

### Which namespace do I use?

Ask "where does this string belong when the widget moves or the feature is deleted?"

- **Feature** — domain strings: form labels, API error messages, status values, anything tied to the feature's business logic.
- **Widget** — UI-surface strings specific to this widget's presentation: modal titles, empty-state copy, accessibility labels, helper text.
- **Global (`common`)** — truly reusable across the whole app: "Cancel", "Save", "Loading...". Last resort, not a convenience dumping ground.

The validator rejects multi-segment namespaces (except the widget prefix): `useTranslations('booking.form')` → use `useTranslations('booking')` + `t('form.xxx')` instead. This keeps each namespace a single JSON tree with predictable shape.

## Config

`i18n.config.json` at the project root controls everything Lexen knows about the project:

```json
{
  "srcDir": "src",
  "locales": ["ru", "kk"],
  "defaultLocale": "ru",
  "filePatterns": ["**/*.{ts,tsx}"],
  "ignore": ["**/*.d.ts", "**/node_modules/**"],
  "hook": {"name": "useTranslations", "package": "next-intl"},
  "layout": {
    "feature": "features/{namespace}/locales/{locale}.json",
    "widget": "widgets/{widget}/locales/{locale}.json",
    "widgetNamespacePrefix": "widget",
    "global": "i18n/messages/{locale}.json",
    "globalNamespace": "common",
    "featuresDir": "features",
    "widgetsDir": "widgets"
  }
}
```

- `hook.name` / `hook.package` — which hook the AST looks for. Swap to `useTranslation` + `react-i18next` to repurpose this for a React Native project.
- `layout.*` — path templates with `{namespace}`, `{widget}`, `{locale}` placeholders.
- Widget support is opt-in. Leave `layout.widget` / `widgetNamespacePrefix` / `widgetsDir` unset to disable it.
- `resolver` — optional. `"ast"` (default) or `"typechecker"`. The typechecker mode loads the project's `tsconfig.json` and uses the TypeScript type-checker to resolve non-literal args (`t(item.labelKey)`, `useTranslations(CONFIG[k].ns)`, template holes whose type is a string-literal union). Object form `{"mode": "typechecker", "propFlow": true, "tsconfig": "tsconfig.json"}` exposes the sub-flags — `propFlow` enables caller-passed `t` prop resolution (default `true` when `mode` is `typechecker`).
- `calls` — optional array of custom call-extractor configs (see §Custom call extractors below).

### Config JSON Schema

Add the `$schema` field to get IDE validation and autocomplete for `i18n.config.json`:

```json
{
  "$schema": "./node_modules/@thelol3882/lexen/schema/i18n.config.schema.json"
}
```

`lexen init` scaffolds this line automatically (all presets include it).

### Custom call extractors (`calls`)

Builder functions that read from the message tree (e.g. `buildMetadata({namespace, key})`)
can be taught to lexen via the `calls` array:

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

- `callee` — function name (or array of names) to match at call sites.
- `package` — optional import-source filter; only matches calls where the callee was imported from this module (mirrors `hook.package`).
- `arg` — index of the object-literal argument (default `0`).
- `namespace` — `prop` is the object property holding the namespace; `default` is used when the prop is absent.
- `keys` — key templates; `${propName}` holes are filled from the object argument's properties, cartesian-expanded across all holes.
- `defaults` — literal fallbacks for props absent at a given call site.

### Choosing a resolver

- Start with `"ast"` — zero setup, works everywhere.
- Switch to `"typechecker"` when you have recurring `t(variable)` / `useTranslations(variable)` patterns and find yourself adding `preserve` entries to work around them. Run `lexen extract --compare-resolvers` first to see exactly which keys the typechecker would add.
- The typechecker resolver needs a valid `tsconfig.json` at the project root (or set `resolver.tsconfig`) so it can load symbols and `paths` aliases.

## Workflow

1. Write code with `t('key')` calls — use descriptive dot-separated keys.
2. Run `lexen extract` — auto-creates / updates locale JSON files with missing keys as empty strings.
3. Fill in the translations (search for `""` in the locale files).
4. `lexen check` must pass before commit.

### Dynamic keys

Template literals like `` t(`status.${kind}`) `` are auto-detected. The static prefix is preserved from `--clean` removal, so every `status.*` key stays regardless of which specific ones appear statically.

```tsx
const STATUSES = ['pending', 'confirmed', 'cancelled'] as const;
return <Badge>{t(`status.${status}`)}</Badge>;  // all three keys survive --clean
```

No manual annotations needed.

### Bare `useTranslations()` is rejected

A `useTranslations()` call with no namespace argument is flagged as an invalid usage — see [`RULES.md`](./RULES.md) rule 5. Call the hook twice (or more) with a literal namespace each time instead of threading full paths through a single root-scoped `t`:

```tsx
// rejected by lexen check
const t = useTranslations();
t('schedule.modal.group');
t('common.create');

// accepted
const tSchedule = useTranslations('schedule');
const tCommon = useTranslations('common');
tSchedule('modal.group');
tCommon('create');
```

### Safe clean — lexen never silently loses a key

`extract --clean` removes unused keys, but it will **not** prune a namespace
that has unresolved dynamic calls. If a `useTranslations(<expr>)` can't be
traced to a literal namespace, or an unattributable `t(<expr>)` is found
anywhere in scope, the clean for that namespace (or the whole run if the
namespace itself is unknown) is blocked:

```
ru: 3 unused kept — namespace has unresolved dynamic keys; --force to prune
```

Use `--force` to override and prune anyway. Use `lexen lint` first to see
exactly which call sites are unresolved — fix those, then re-run `--clean`
without `--force`.

### `lexen lint` — rules-violation diagnostics

```bash
pnpm lexen lint [feature] [--naming] [--format=human|github|json]
```

Surfaces every rule violation with a precise `file:line:col` location and a
fix hint, grouped by rule. No writes — report only.

```
rule 2 · unresolved t() key (3)
  ! src/features/booking/BookingCard.tsx:42:12  t(item.statusKey)
    → key not statically resolvable — store t('…') in data, or type the
      template hole as a literal union (rule 6).
```

Default: rules 1, 2, 4, 5, 9 (runtime-risk correctness rules). Add
`--naming` to include rule 7 (camelCase key naming) — it's opt-in because it
produces style nits rather than correctness findings.

Exit 1 if any violations are found. See [`RULES.md`](./RULES.md) for the
full rule reference.

### `check --strict` — one command for CI

```bash
pnpm --silent lexen check --strict
```

Folds `lexen lint` correctness rules into `check`. Exit 1 if there is any
locale drift **or** any lint violation. Combine with `--format=github` for
inline PR annotations:

```bash
pnpm --silent lexen check --strict --format=github
```

### `--format=human|github|json`

Both `check` and `lint` accept `--format`:

| Format | Output |
|---|---|
| `human` | Default — color-coded terminal output |
| `github` | `::error file=…,line=…,col=…::message` — GitHub Actions annotations |
| `json` | Structured JSON report / violation array to stdout |

**`pnpm --silent` is required for machine formats.** Plain `pnpm` prints its
lifecycle banner to stdout and corrupts piped JSON. Either use
`pnpm --silent lexen …` or invoke the bin directly (`./node_modules/.bin/lexen …`).

## What Lexen can't see (static-extraction limits)

> The typechecker resolver (`"resolver": "typechecker"`) removes most of the limits below. This section describes behaviour in the default `"ast"` mode and the rare cases no resolver can reach.

Lexen reads `t('...')` calls via the TypeScript AST. In `"ast"` mode it can **only** resolve arguments that are string literals or template literals with a literal prefix. Anything that goes through a variable is invisible — the compiler has no way to know the value.

Invisible to Lexen:

```tsx
// Key stored in data, passed via variable — AST sees `t(stat.labelKey)` only.
const stats = [{labelKey: 'stats.totalCarwashes', ...}];
return stats.map(s => <Text>{t(s.labelKey)}</Text>);

// Function returns the key.
return <Text>{t(getLabel(kind))}</Text>;

// Ternary / logical with non-literal operands.
return <Text>{t(cond ? dynamicA : dynamicB)}</Text>;
```

Symptom: `lexen check` passes ("all synced"), but the runtime throws `MISSING_MESSAGE: Could not resolve "<key>" in messages for locale "<x>"`. The keys aren't in the JSON because no literal ever appeared in source.

**Fixes, in order of preference:**

1. **Resolve the label at the call site, store the result, not the key.** Usually the cleanest refactor:
   ```tsx
   const stats = [
       {label: t('stats.totalCarwashes'), value: ...},
       {label: t('stats.totalBookings'), value: ...},
   ];
   return stats.map(s => <Text>{s.label}</Text>);
   ```
   All four literals are now statically visible.

2. **Template-literal prefix** for genuinely data-driven keys (e.g. an enum mapped to a translation):
   ```tsx
   t(`status.${kind}`)   // kind: 'pending' | 'confirmed' | 'cancelled'
   ```
   Lexen auto-preserves `status.*` from `--clean` removal, but it still won't *create* the keys — you seed them once, then they survive.

3. **Switch to `"resolver": "typechecker"`** — the type-checker resolves most dynamic shapes automatically (string-literal unions, `Record<K, V>` property access, template holes). You usually won't need `preserve` once it's on. See §Config above.

4. **`preserve` config directive** — declare dynamic namespaces/prefixes explicitly in `i18n.config.json` (for truly-runtime cases: `t(fn())`, `t(api.x())`, etc. that even the typechecker can't resolve):
   ```json
   "preserve": {
     "navigation": "*",
     "widget.dashboard": ["academyStats.*", "ownerStats.*", "quickActions.*"],
     "widget.finance": ["expenses.*"]
   }
   ```
   - `"*"` — preserve every key under that namespace (for fully-dynamic cases like nav labels resolved via config array).
   - `["prefix.*", ...]` — preserve keys under specific prefixes (for `useTranslations(config.translationNamespace)` cases where the namespace is dynamic but the prefix set is known).

   Preserved keys survive `extract --clean` and aren't reported as unused. Does NOT auto-create missing keys — locale files must still contain the values (you populate them manually or keep the values that were there before `--clean`).

If you hit `MISSING_MESSAGE`, grep the source for the key's last segment and look for a `t(<variable>)` call nearby — that's almost always the shape.

## Presets

`lexen init` copies a preset to `<projectRoot>/i18n.config.json`:

```bash
lexen init                       # default preset = next-intl
lexen init --preset=<name>       # next-intl | react-i18next
lexen init --force               # overwrite an existing config
```

Without `--force` it refuses to clobber an existing file (exit code 3). Unknown preset names exit 1.

| Preset | Framework | Hook | Layout shape |
|---|---|---|---|
| `next-intl` | Next.js + next-intl | `useTranslations` from `next-intl` | Global at `i18n/messages/{locale}.json`, features at `features/{namespace}/locales/{locale}.json`. |
| `react-i18next` | React / React Native + react-i18next | `useTranslation` from `react-i18next` | Global at `locales/{locale}/common.json`, features at `features/{namespace}/locales/{locale}.json`. |

Both presets default to a single-locale (`["en"]`) setup so a new project boots cleanly.

## Exit codes

For CI pipelines: route failures by exit code.

| Code | Meaning |
|---|---|
| `0` | success — no drift, no invalid usages |
| `1` | key drift — missing, unused, or placeholder-drift keys |
| `2` | invalid namespace usage — hook called with a non-existent or malformed namespace |
| `3` | config or usage error — `i18n.config.json` missing/malformed, unknown subcommand, no args |

`lexen check` returns any of these; `extract` / `sort` / `init` return `0` on success or `3` on config error.

## Placeholder drift

`lexen check` validates that every locale uses the same ICU placeholder variables for each key:

```
// ru
"greeting": "Привет, {name}!"
// kk — missing {name}
"greeting": "Сәлем!"
```

→ reported as `placeholder drift in "common.greeting": kk missing {name}` at the namespace's first usage site.

Also catches malformed ICU (unbalanced braces). Empty-string values are skipped (reported elsewhere as untranslated).

## Development

Clone, install, build, test:

```bash
git clone <repo>
cd lexen
pnpm install
pnpm typecheck
pnpm test                      # runs the fixture suite
pnpm build                     # produces dist/
pnpm dev -- check              # run the CLI directly via tsx
```

### Module layout

```
lexen/
├── index.ts            CLI entry — parses argv, dispatches subcommands.
├── config.ts           Loads + validates i18n.config.json.
├── extract.ts          AST-based key extraction (TypeScript compiler API).
├── extract-resolver.ts Typechecker-backed string-literal resolution.
├── locales.ts          Read / write / sort locale JSON files, discover valid namespaces.
├── validate.ts         Namespace usage + ICU placeholder-drift + preserve hygiene.
├── sync.ts             Reconciles extracted keys ↔ locale files.
├── lint.ts             `lexen lint` — rules-violation diagnostics.
├── reporters.ts        Output formatters (human / github / json).
├── types.ts            Shared type definitions.
├── schema/             Config JSON Schema (i18n.config.schema.json).
├── util/
│   ├── log.ts          ANSI color helpers.
│   └── paths.ts        Config-driven path resolution + scope detection.
├── presets/            Starter i18n.config.json templates.
└── __tests__/
    ├── fixtures/       Hand-crafted TS project exercising each resolver pattern.
    └── run-fixtures.ts Dependency-free fixture runner (`pnpm test`).
```

ESM throughout, no global state. `index.ts` is the only file that touches `process.argv` / `process.exit`. Everything else is a pure function taking a resolved config object.

### Extending the validator

`validate.ts` exports `findInvalidNamespaceUsages(...)`, `findPlaceholderDrift(...)`, and friends. To add a new check, add another function with the same shape and call it from `sync.ts` alongside the existing ones. No CLI changes needed.

### Adding a preset

Drop a new `presets/<name>.json` file — the CLI discovers presets dynamically. Make sure to also update the `Presets` table in this README.

## License

MIT — see [`LICENSE`](./LICENSE).
