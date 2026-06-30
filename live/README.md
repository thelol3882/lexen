# @thelol3882/lexen-live

Dev-only live-edit overlay for [`@thelol3882/lexen`](https://github.com/thelol3882/lexen).

Wraps every translation string in an invisible Unicode marker, intercepts
alt/cmd-click in the browser, and routes edits back through lexen core's
IO layer with `lexen check` as the write-gate.

**Zero production cost — proven, not assumed.** See [Bundle Safety](#bundle-safety).

---

## Installation (vendored tarball — same model as lexen core)

```sh
# 1. Pack the tarball from this directory
cd lexen/live
pnpm pack        # produces thelol3882-lexen-live-0.1.1.tgz

# 2. Copy into the app's vendor directory
cp thelol3882-lexen-live-0.1.1.tgz path/to/app/vendor/

# 3. Add to app's package.json as a DEVDEPENDENCY
#    "devDependencies": {
#      "@thelol3882/lexen-live": "file:vendor/thelol3882-lexen-live-0.1.1.tgz"
#    }
```

The Dockerfile's existing `COPY vendor ./vendor` line covers the new tarball automatically.

---

## Usage

### 1. Add the Route Handler

```ts
// src/app/api/lexen-live/route.ts
export { GET, POST } from '@thelol3882/lexen-live/next/route';
```

### 2. Wrap the Provider

```tsx
// src/providers.tsx  (replace <NextIntlClientProvider> in dev)
import dynamic from 'next/dynamic';
import { NextIntlClientProvider } from 'next-intl';

const LexenLiveProvider =
  process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_LEXEN_LIVE
    ? dynamic(() =>
        import('@thelol3882/lexen-live/client').then((m) => m.LexenLiveProvider)
      )
    : null;

export function Providers({ locale, messages, children }) {
  const Provider = LexenLiveProvider ?? NextIntlClientProvider;
  return (
    <Provider locale={locale} messages={messages} timeZone="UTC">
      {children}
    </Provider>
  );
}
```

### 3. Enable in dev

```sh
NEXT_PUBLIC_LEXEN_LIVE=1 next dev --turbopack
```

Alt/Cmd-click any translated string to open the edit panel.

---

## Bundle Safety

Three layered guarantees — the last one is empirically proven, not assumed:

1. **Static gate**: every entry is behind a literal `process.env.NODE_ENV !== 'production'`
   AND `process.env.NEXT_PUBLIC_LEXEN_LIVE` check. Both are inlined as literals by
   Turbopack/Next, making the dead branch DCE-eligible.

2. **Dynamic import isolation**: `LexenLiveProvider` is only reachable via
   `next/dynamic(...)` in the dev path. The package is a `devDependency` of the app
   (never in the prod dependency closure), and Next's `output: 'standalone'` module
   tracing will not copy it into `.next/standalone`.

3. **Build-time proof** (`pnpm verify` in the app, or `node live/scripts/verify-no-markers.mjs`
   after `next build`): grepping `.next/static/**` and `.next/server/**` for the four
   sentinel codepoints (U+200B, U+200C, U+200D, U+2060) and for the literal symbols
   `LexenLive` / `__LEXEN_LIVE__` / `@thelol3882/lexen-live`. Any hit fails the build.

---

## Architecture

- **Marking**: deep-clones the next-intl `messages` tree before it reaches ICU and
  prefixes every leaf string with an invisible 12-character Unicode sequence encoding a
  20-bit key ID. The marker is a boundary prefix, outside any `{...}` ICU braces, so
  plural/select/interpolation/number/date formatting is untouched.

- **Observer**: a `MutationObserver` maps marked DOM text nodes back to their `KeyRef`
  (namespace + dotKey) via a module-level `Map<number, KeyRef>`.

- **Panel**: alt/cmd-click opens a side panel anchored to the real rendered bounding box,
  showing current values for all locales. Edits are saved via the route handler.

- **Write-back**: the route handler deep-imports lexen core (`resolveNamespaceScope`,
  `readNamespace`, `setNestedValue`, `writeNamespace`) then runs `runSync({checkOnly: true})`
  as a gate before confirming the write.

- **Agent loop**: the same mechanism works headlessly via Playwright — a screenshot
  reveals overflow, an AI agent self-corrects and saves.

---

## Package Layout

```
live/
  src/
    shared/          <- protocol.ts, markers-spec.ts  (shared contracts, no deps)
    client/          <- LexenLiveProvider, codec, observer, panel  (browser)
    server/          <- handleGet, handlePost, getConfig  (Node.js, lexen-core imports)
    next/            <- GET/POST route handler re-export  (Next.js)
  scripts/
    verify-no-markers.mjs   <- post-build bundle grep CI gate
  dist/              <- compiled output (tsc)
```

Coupling to core: `@lexen/live/server` deep-imports lexen core's compiled modules
(`@thelol3882/lexen/dist/*.js`). Core has no `exports` map, so Node permits deep
imports. No lexen core **source** is changed and no runtime dependency is added.

### One sanctioned core build-scoping change

Because this package is nested inside the lexen repo, core's root `tsconfig.json`
(`include: ["**/*.ts"]`) would otherwise try to compile `live/`'s JSX/DOM sources
and fail. The single additive change `exclude: [..., "live"]` scopes the nested
package out of core's build. It is **non-behavioral**: it does not touch lexen's
static-extraction logic, and `pnpm test` / `pnpm typecheck` / `pnpm build` all stay
green. This is the one accepted exception to "zero core files touched" and is the
direct consequence of hosting `@lexen/live` as a subdirectory (the chosen layout).
If the package is ever relocated to a sibling repo, revert that `exclude` entry.
