# Lexen — Extraction Guidance & Diagnostics

> **Lexen never silently loses a key.**
>
> `extract --clean` will not prune a namespace that has unresolved dynamic
> keys. If a `useTranslations(<expr>)` call can't be traced to a literal
> namespace, or an unattributable `t(<expr>)` is found anywhere in the
> codebase, the entire clean is blocked — you'll see the reason printed and
> must pass `--force` to override. For the keys it *can* attribute, only the
> namespace(s) whose `t` calls are all resolved get pruned.
>
> Violations are surfaced precisely by `lexen lint` — `file:line:col` +
> a fix hint — so you never have to grep for them manually.

---

## The one hard rule

### Rule 5 — One namespace per hook call; single-segment namespaces only

`useTranslations(...)` must receive a **string literal**, and that literal
must match a namespace lexen knows about (a `locales/` dir under a feature
or widget). Multi-segment namespace names are rejected except for the `widget.<name>` prefix.

```tsx
// ✅ Good — one literal namespace per call
const t = useTranslations('auth');
const tCommon = useTranslations('common');
const tDash = useTranslations('widget.dashboard');

// ❌ Hard error — multi-segment; lexen check exits 2
useTranslations('auth.form');   // use ('auth') + t('form.xxx') instead

// ❌ Hard error — non-existent namespace
useTranslations('doesNotExist');
```

`lexen check` exits 2 on a rule-5 violation. This is the only rule that
blocks `check` with a hard exit code — it's an architectural constraint (one
namespace = one JSON tree on disk), not just an analysis limit.

**One hard rule. That's it.** Everything else below is guidance for clean
auto-extraction — if you can't follow it, lexen tells you where and how,
and `--clean` won't silently prune anything.

---

## Extraction guidance (rules 1–4, 6)

The typechecker resolver (`"resolver": "typechecker"` in config) handles
most dynamic patterns automatically. For the default `"ast"` resolver, the
following patterns are invisible and produce an **unresolved call** warning.
`lexen lint` pins each one to `file:line:col`.

### Rule 1 — Namespace as a string literal

```tsx
// ✅ Best — literal, always resolved
const t = useTranslations('auth');

// ⚠️  Dynamic — use typechecker resolver; if the type widens to plain
//    `string`, lexen lint flags it as rule 1 and --clean is blocked for
//    any namespace whose keys might be affected.
useTranslations(config.namespace);
useTranslations(ROLE_MAP[role].ns);
```

The typechecker resolver resolves `ROLE_MAP[role].ns` when `ROLE_MAP` is
typed as a `Record<Role, {ns: 'admin' | 'owner'}>` — all possible values are
enumerated. If the type widens to `string`, `lexen lint` surfaces it.

### Rule 2 — Key as a string literal or typed template literal

```tsx
// ✅ Literal — always resolved
t('welcomeBack');
t('forms.login.submit');

// ✅ Template with typed hole — typechecker resolves all variants
type Status = 'pending' | 'confirmed' | 'cancelled';
t(`status.${status}`);   // emits status.pending, status.confirmed, status.cancelled

// ⚠️  Variable — invisible in ast mode; typechecker resolves it if the
//    type is a string-literal union. If not, lexen lint flags it as rule 2.
t(item.labelKey);
t(variable);
```

### Rule 3 — Resolve at the call site, don't store keys in data

```tsx
// ❌ Anti-pattern — labelKey is a runtime string; keys are invisible
const stats = [
    {labelKey: 'stats.totalPlayers', value: 42},
    {labelKey: 'stats.totalCoaches', value: 7},
];
return stats.map(s => <Text>{t(s.labelKey)}</Text>);

// ✅ Preferred — call t() immediately, store the result
const stats = [
    {label: t('stats.totalPlayers'), value: 42},
    {label: t('stats.totalCoaches'), value: 7},
];
return stats.map(s => <Text>{s.label}</Text>);
```

When you can't refactor (config objects shared across modules), the
typechecker resolver handles `t(item.labelKey)` if `labelKey`'s type is a
string-literal union. If it's `string`, `lexen lint` flags rule 2 at the
call site — and `--clean` blocks pruning of the affected namespace.

### Rule 4 — Each component owns its own `useTranslations()`

```tsx
// ❌ t passed as prop — propFlow may not trace back to the source namespace
<PlayerCard t={t} />

// ✅ Child calls the hook itself — always correctly attributed
function PlayerCard() {
    const t = useTranslations('players');
    return <Text>{t('title')}</Text>;
}
```

With `"propFlow": true` (on by default in typechecker mode), lexen traces
`t`-as-prop back through callers to find the originating
`useTranslations(ns)`. When the trace fails (e.g. the prop type is widened to
`(key: string) => string`), `lexen lint` flags rule 4 at the call site and
`--clean` is blocked.

### Rule 6 — Template-literal holes require a literal union type

```tsx
// ✅ Literal union — lexen creates and preserves all 5 keys
type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
t(`status.${status}`);   // emits all five under the current namespace

// ⚠️  Plain string — lexen preserves the `status.*` prefix from --clean
//    but won't seed the keys; you populate them once, then they survive.
const status: string = booking.status;
t(`status.${status}`);
```

Type every enum-like value as a literal union for TypeScript correctness and
i18n enumeration at once.

---

## Style guidance

### Rule 7 — camelCase key naming (opt-in via `lexen lint --naming`)

```tsx
t('submitButton')        // ✅ camelCase leaf
t('forms.login.submit')  // ✅ dot-hierarchy

t('submit_button')       // style nit — surfaced by --naming
t('SubmitButton')        // style nit
```

Rule 7 is opt-in because it's a style preference, not a correctness concern.
On a large codebase it can produce many findings (126 nits vs. 16 real rule
violations in igadin). Add `--naming` when you want to enforce it.

---

## Automated enforcement (rules 8–10)

### Rule 8 — Don't hand-add keys to locale JSON

New keys enter as `t('newKey')` calls; `lexen extract` creates the empty
`""` entries. Hand-adding a key to `ru.json` without a matching `t()` call
guarantees it's reported as "unused" (and pruned on the next `--clean`).

**OK to hand-edit:** existing keys' *values*. **Not OK:** adding new keys.

### Rule 9 — ICU placeholders must match across locales

Enforced automatically by `lexen check` and `lexen lint` (placeholder drift
detection). If a locale is missing `{name}` that another locale has, lexen
reports it. Fix the translation, not the code.

### Rule 10 — CI enforcement, not manual checklist

Run `lexen check --strict` in CI (or as a pre-commit hook). It gates both
locale-sync correctness *and* all lint rules in one command — exit 1 if
either has violations. The tool remembers; the developer doesn't have to.

```bash
# CI / pre-commit
pnpm --silent lexen check --strict
```

---

## `lexen lint` replaces the manual grep sweep

The old "Grep patterns for cleanup" section no longer applies. `lexen lint`
finds every rule 1/2/4/5/9 violation with precise `file:line:col` locations
and fix hints, grouped by rule. Add `--naming` to include rule 7 style nits.

```bash
pnpm lexen lint            # correctness rules (1, 2, 4, 5, 9)
pnpm lexen lint --naming   # + camelCase nits (rule 7)
pnpm lexen lint --format=github  # CI annotations (::error file=…::)
pnpm lexen lint --format=json    # machine-readable violation array
```

Exit 1 if any violations are found.

---

## Escape hatch: truly-runtime keys

For keys that genuinely can't be made static (API-returned translation keys,
user-generated content), declare them in the `preserve` block with a
justification:

```json
{
  "preserve": {
    "widget.dashboard": ["apiDrivenMetrics.*"]
  }
}
```

Preserved keys survive `extract --clean` and aren't reported as unused. They
must already exist in locale files — `preserve` doesn't create them.

With safe-clean in place, `preserve` is less critical than it used to be:
even without it, `--clean` won't prune a namespace that has live unresolved
calls. But for truly-runtime values that will never have a static call site,
`preserve` is the correct tool.

The ROADMAP has a planned in-source `// @lexen-preserve <ns>.<prefix>.*`
directive as a per-file alternative to the global config entry.

**Before reaching for preserve:** try the four options in the README §"What
Lexen can't see" (resolve-at-call-site → template prefix + union type →
typechecker resolver → preserve). Preserve is option 4 of 4.
