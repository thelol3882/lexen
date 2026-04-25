# Lexen — Static-Key Rules

> Developer discipline rules that keep lexen reliable. If code follows these
> rules, `pnpm lexen check` stays green and the runtime never throws
> `MISSING_MESSAGE`.

## Why these rules exist

Lexen reads source via the TypeScript compiler (AST + typechecker). Anything
it can't see statically is invisible to `pnpm lexen extract`. Then `--clean`
prunes "unused" keys from locale JSONs — except those keys *are* used at
runtime via dynamic arguments. Result: `MISSING_MESSAGE` at runtime, in
production, after the PR is already merged.

These 10 rules make sure every key a user sees is visible to lexen
statically.

---

## 1. Namespace must be a string literal

`useTranslations(...)` takes a literal namespace name. No variables, no
property access, no function calls.

```tsx
// ✅ Good
const t = useTranslations('auth');
const tCommon = useTranslations('common');
const tWidget = useTranslations('widget.dashboard');

// ❌ Bad — namespace invisible to static analysis
useTranslations(config.namespace);
useTranslations(ROLE_MAP[role].ns);
useTranslations(getNamespace());
```

**Why:** even though lexen's typechecker resolver *can* handle
`ROLE_MAP[role].ns` in many cases, it's fragile — a type widening to
`string` (API response, a `.find()` call, etc.) silently breaks extraction.
Literal namespace = guaranteed visibility.

---

## 2. Key must be a string literal or a template literal with a literal prefix

```tsx
// ✅ Good
t('welcomeBack');
t('forms.login.submit');
t(`status.${status}`);    // literal prefix `status.` — see rule 6

// ❌ Bad — key invisible
t(variable);
t(item.labelKey);
t(getLabel());
t(cond ? dynamicA : dynamicB);
```

**Why:** lexen walks `t(<literal>)` calls via AST. A variable argument has no
compile-time value.

---

## 3. Resolve the translation at the call site, not in data

Store the translated *string* in data, never the translation *key*.

```tsx
// ❌ Bad — labelKey is a dynamic string, keys invisible
const stats = [
    { labelKey: 'stats.totalPlayers', value: 42 },
    { labelKey: 'stats.totalCoaches', value: 7 },
];
return stats.map(s => <Text>{t(s.labelKey)}</Text>);

// ✅ Good — call t() immediately, store the result
const stats = [
    { label: t('stats.totalPlayers'), value: 42 },
    { label: t('stats.totalCoaches'), value: 7 },
];
return stats.map(s => <Text>{s.label}</Text>);
```

**Why:** this is the most common i18n anti-pattern and the root cause of the
75994b0 / 12446d7 regression class. The fix is almost always trivial — rename
`labelKey` to `label` and wrap in `t()`.

**Exception:** config objects shared across modules where the consumer picks
the key. Use rule 6 (typed union) or rule 4 (child calls its own hook).

---

## 4. Each component owns its own `useTranslations()`

Don't pass `t` or namespace strings through props. Child components call the
hook themselves.

```tsx
// ❌ Bad — child's keys are orphaned from their namespace
<PlayerCard t={t} />
<PlayerCard translationNamespace="players" />

// ✅ Good — child owns its i18n binding
function PlayerCard() {
    const t = useTranslations('players');
    return <Text>{t('title')}</Text>;
}
```

**Why:** when `t` is a prop, lexen has to trace it back to the parent's
`useTranslations` call to know the namespace. The typechecker resolver does
this (`propFlow` flag), but it's brittle across component boundaries and
breaks when the prop type is widened (`t: (key: string) => string`). Local
hook calls are always mechanically correct.

---

## 5. One namespace per hook call

If a component needs two namespaces, call the hook twice. No multi-segment
namespaces (except the `widget.` prefix).

```tsx
// ✅ Good
const t = useTranslations('auth');
const tCommon = useTranslations('common');

// ❌ Bad — lexen validator rejects multi-segment
useTranslations('auth.form');   // use ('auth') + t('form.xxx') instead
```

**Why:** each namespace is one JSON tree on disk. Multi-segment bindings
confuse the file-layout rules (is `auth.form` a feature or a sub-object?).

---

## 6. Template-literal dynamic keys require a literal union type

`` t(`status.${x}`) `` only enumerates all variants if `x` is typed as a
literal union. Plain `string` = lexen keeps the prefix alive under `--clean`
but won't create the keys automatically.

```tsx
// ✅ Good — literal union, lexen creates all 5 keys
type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
const status: BookingStatus = booking.status;
t(`status.${status}`);
// extract adds status.pending, status.confirmed, ... all 5 to ru.json + kk.json

// ⚠️  Degraded — plain string, lexen preserves `status.*` from --clean but
//     won't seed new keys; you populate the JSON once, then they survive.
const status: string = booking.status;
t(`status.${status}`);

// ❌ Bad — variable, no template literal at all
const key = `status.${status}`;
t(key);
```

**Practical rule:** type every enum-like value (statuses, roles, categories,
actions) as a literal union, not `string`. You get TypeScript correctness
*and* i18n enumeration for free.

**How to verify:** `pnpm lexen extract --compare-resolvers` shows exactly
which keys typechecker resolves vs. the plain AST.

---

## 7. Key naming: camelCase + dot-notation

```tsx
t('submitButton')           // ✅ leaf key — camelCase
t('forms.login.submit')     // ✅ nested — dots for hierarchy
t('submit_button')          // ❌ snake_case
t('SubmitButton')           // ❌ PascalCase
t('submit-button')          // ❌ kebab-case
```

**Why:** matches Next.js / next-intl conventions and keeps JSON trees
readable. Dots are tree separators — they're load-bearing (`forms.login`
becomes a nested object, not a flat key).

---

## 8. Don't edit locale JSON files to add keys

New keys enter the codebase as `t('newKey')` calls. Then `pnpm lexen
extract` creates the JSON entries as empty `""`, and you fill in the
translations.

```
Step 1: Write t('settings.emailNotifications') in code
Step 2: Run `pnpm lexen extract`
Step 3: Open features/settings/locales/ru.json — find the empty "" you just
        created — fill it in
Step 4: Same for kk.json
Step 5: pnpm lexen check → must pass
```

Hand-adding a key to `ru.json` (but not calling `t()`) guarantees drift on
the next `--clean`.

**OK to hand-edit:** existing keys' *values* (the translation text itself).
NOT OK: adding new keys.

---

## 9. ICU placeholders must match across `ru.json` and `kk.json`

```json
// ✅ Good — both locales have {name}
// ru.json
"greeting": "Привет, {name}!"
// kk.json
"greeting": "Сәлем, {name}!"

// ❌ Bad — kk missing {name}, lexen check reports placeholder drift
"greeting": "Сәлем!"
```

Lexen's `findPlaceholderDrift()` catches this. Same placeholder names in
every locale, always. If translator skips one — fix the kk translation, not
the check.

---

## 10. Run before every PR

```bash
pnpm lexen check      # drift / unused / placeholder / invalid-namespace
pnpm lint             # hardcoded JSX strings + (once enforced) dynamic hook args
```

Both must exit 0. CI will enforce this on PRs. If `lexen check` fails:

- **"missing in locale"** → `pnpm lexen extract`, fill the new `""`s
- **"unused on disk"** → either remove stale keys (`pnpm lexen extract --clean`)
  OR the key is dynamically referenced — fix via rule 3 / 6, don't add to
  preserve as first resort
- **"placeholder drift"** → fix the translation, not the code
- **"invalid namespace"** → you hit rule 1 or rule 5

---

## Escape hatch: truly-runtime keys

For keys that really can't be made static (API-returned translation keys,
user-generated content, etc.), declare them in `i18n.config.json` `preserve`
block **with a justification comment in the PR description**. This is a last
resort. Currently:

```json
// i18n.config.json
{
  "preserve": {
    "widget.dashboard": ["apiDrivenMetrics.*"]
  }
}
```

The ROADMAP has a planned in-source `// @lexen-preserve <ns>.<prefix>.*`
directive to replace global preserve entries — when it ships, prefer the
inline directive over editing the config.

**Before reaching for preserve:** try all four options in the lexen README §
"What Lexen can't see" (resolve-at-call-site → template prefix with typed
union → typechecker → preserve). Preserve is option 4 of 4.

---

## Quick reference (for cleanup PRs)

When fixing a file to follow these rules, check:

- [ ] Every `useTranslations(...)` arg is a string literal (rule 1)
- [ ] Every `t(...)` arg is a string literal or template with literal prefix (rule 2)
- [ ] No data structures that store translation *keys* — store the translated *string* (rule 3)
- [ ] No `t`-props or namespace-props between components (rule 4)
- [ ] No multi-segment namespaces except `widget.<name>` (rule 5)
- [ ] Template-literal hole variables are typed as literal unions, not `string` (rule 6)
- [ ] Keys use camelCase + dot-notation (rule 7)
- [ ] After code changes: `pnpm lexen extract` → fill empty `""`s → `pnpm lexen check` green

---

## Grep patterns for cleanup

Common anti-patterns to search for during the 1-2 day cleanup sweep:

```bash
# Rule 1 violations — dynamic namespace
rg "useTranslations\([^'\"]" src/

# Rule 2 violations — dynamic t() arg (heuristic)
rg "\bt\([a-zA-Z_][a-zA-Z0-9_.]*\)" src/     # t(variable) — no quotes
rg "\bt\([a-zA-Z_]+\." src/                  # t(obj.key)

# Rule 3 violations — labelKey / translationKey / messageKey in data
rg "labelKey|translationKey|messageKey|translationNamespace" src/

# Rule 4 violations — t passed as prop
rg "t={t}|t: t," src/
rg "t\?: \(.*\) => string" src/

# Rule 7 violations — non-camelCase keys
rg "t\('[^']*_[^']*'\)" src/                 # snake_case in t()
```

Run each, fix, then `pnpm lexen check` + `pnpm lint` before committing.
