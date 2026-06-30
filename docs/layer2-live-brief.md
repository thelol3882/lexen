# Build @lexen/live — in-context (live-render) translation editing for lexen

> Brief for a fresh session. Start in `C:\Users\111\WebstormProjects\lexen`,
> paste/run this, and drive it as a dynamic multi-agent Workflow.

## Role & orchestration
Run as a multi-phase dynamic workflow (use the **Workflow** tool, not `/loop`).
Opus owns research / consensus / verification; Sonnet owns code. Gate every phase.

- **Research council — 3× Opus, parallel, distinct lenses.** Spawn three Opus
  research agents concurrently, each with its own mandate (not redundant):
  1. **Runtime mechanics** — tagging rendered strings via invisible Unicode
     markers, the cleanest `next-intl` interception point, DOM-node → key
     mapping, and failure modes (SSR/hydration mismatch; markers leaking into
     `value`/`aria-*`/`title`/`alt`; `===`/`.length`/number+date formatting;
     React key warnings; `t.rich`/`t.markup`).
  2. **Integration & architecture** — how `@lexen/live` couples to lexen
     (new programmatic library API vs. shelling to the CLI vs. direct file I/O),
     write-back protocol, dev-server transport (Next.js route handler vs. ws
     sidecar), dev/prod gating, packaging + vendored-tarball distribution.
  3. **Prior art & red-team** — study Tolgee / inlang / Lingui in-context
     editors and similar; extract proven patterns + known pitfalls; act as the
     skeptic that scores the other two's proposals and hunts holes.
  Each returns a cited findings brief + a recommended design for its slice.
- **Consensus — Opus.** A reconciliation round: cross-review the three outputs,
  converge on ONE architecture (2–3 options scored → pick one). Re-run the round
  if they disagree; if a disagreement is fundamental, surface it to the human
  rather than guess. Output = a single agreed design + explicit MVP scope.
- **Implementation — Sonnet fan-out.** Only after consensus. Delegate code to
  Sonnet subagents in parallel, each tightly scoped with explicit file targets
  and acceptance checks. Use isolated git worktrees where agents would collide.
- **Verification — 1× Opus, adversarial.** A single Opus verifier checks
  EVERYTHING at the end and tries to BREAK it (not bless it): build/typecheck/
  run, end-to-end click-to-edit, check-gate rejects a bad edit, production
  bundle is clean of all live machinery, headless Playwright pass. Re-delegate
  fixes to Sonnet on any failure, then re-verify.

## Objective
Build `@lexen/live`: a **dev-only** companion package that lets a translator
(human or AI agent) edit translations *in the running app*, seeing the real
rendered UI — including text overflow — and writing edits back to the locale
JSON files, gated by `lexen check`. This is "Layer 2" of lexen's translation-
context work. It is a SEPARATE package, never merged into lexen's static core.

## Background (already built — do not rebuild)
- `lexen` is a static, zero-runtime, framework-agnostic i18n CLI built on the
  TypeScript compiler API. Repo root is this directory.
- **Layer 1 shipped**: `lexen context [feature] [--untranslated] [--format=json]`
  emits, per key, the call-site, wrapping JSX element + style props, an inferred
  `role` + `spaceBudget`, ICU placeholders, and current per-locale values. Read
  `context.ts`, the `lexen context` README section, and the ROADMAP
  "Translation context" entry first — Layer 2 is specified there at a high level.
- lexen already owns the map Layer 2 needs: `key → namespace → file → source
  position`, plus locale read/write (`locales.ts`: `readNamespace` /
  `writeNamespace`) and validation (`validate.ts`: placeholder-drift / ICU).
- Distribution: there is NO npm publish access. lexen ships to projects as a
  vendored tarball (`file:vendor/thelol3882-lexen-X.Y.Z.tgz`) + a Docker
  `COPY vendor ./vendor` step before install. `@lexen/live` must ship the same way.

## Target stack (single-stack on purpose — lean into it)
Next.js (App Router) + `next-intl` (`useTranslations` / `getTranslations`) +
Mantine, locales `ru`/`kk`. Proving ground app: `JU_Platform/web/ju` (Mantine-
heavy customer app). Namespaces: `common` (global), `<feature>`, `widget.<name>`.

## Design decisions already made (build on these; don't re-litigate)
1. **Marker-based key tagging.** In dev, wrap every resolved message string with
   invisible Unicode markers encoding its key (Tolgee's technique) so the key
   travels inside the string into the DOM text node and survives interpolation.
2. **DOM observer + side panel.** A MutationObserver finds marked text nodes; an
   overlay lets the user alt/cmd-click any UI string → see key + all locales +
   the real rendered box (overflow visible) → edit → save.
3. **Write-back through lexen.** Saving routes the edit to the correct locale
   JSON via lexen's key→file map, then runs `lexen check` as a gate (reject on
   placeholder drift / ICU break).
4. **Dev-only, zero prod cost.** Marker wrapping + observer + panel are gated
   behind dev mode / an env flag and must be fully absent from the prod bundle.
5. **Agent+human bridge.** Same loop must work headless: Playwright renders a
   screen → an AI translator sees overflow in a screenshot and self-corrects.
6. **Companion package, not core.** lexen core stays a pure static CLI (per
   STRATEGY.md). `@lexen/live` may depend on a small programmatic API exposed
   from lexen, or shell out to the CLI — decide in research.

## Hard constraints
- Do NOT modify lexen's static-extraction behavior or break its tests
  (`pnpm test`, `pnpm typecheck`, `pnpm build` must stay green).
- `@lexen/live` is its own package/dir; no runtime deps added to lexen core.
- TypeScript, ESM, Windows-friendly. Dev-only; the production build must be
  unaffected (prove the prod bundle has zero markers / observer / panel).
- Reuse lexen's existing key map + locale I/O + `check` — do not duplicate them.

## Phased plan to execute
1. **Research council (3× Opus, parallel).** Run the three lenses above; each
   returns a cited brief + recommended design for its slice.
2. **Consensus + plan (Opus).** Reconcile into ONE architecture (options scored,
   one chosen): package layout, the lexen library-API surface (if any), marker
   scheme, provider/interception, panel↔server protocol, write-back + check
   gate, dev/prod gating, the Playwright agent loop. Define MVP scope + acceptance.
3. **Implement (Sonnet fan-out, Opus-gated).** marker+provider; DOM observer +
   overlay panel; dev server / write-back endpoint; lexen API/CLI hook + check
   gate; build tooling so it vendors as a tarball; example wiring in
   `JU_Platform/web/ju` behind a dev flag.
4. **Verify (1× Opus, adversarial).** typecheck/build/run; click-to-edit a real
   key end-to-end in `web/ju`; confirm overflow is visible; confirm `lexen check`
   blocks a bad edit; confirm the prod build is clean of all live machinery; one
   headless Playwright pass proving the agent bridge.

## Definition of done (MVP)
In `JU_Platform/web/ju` dev mode: alt-click a rendered string → panel shows its
key + ru/kk values + the real box → edit kk → save → the feature's `kk.json`
updates → `lexen check` passes → the UI reflects it. A bad edit (dropped ICU
var) is rejected by the gate. `next build` output contains none of the live
code. A Playwright script can do the same read→detect-overflow→write loop
headlessly. lexen core tests remain green.

## First decision to settle before kicking off
Where `@lexen/live` lives: a subdirectory of the lexen repo (recommended for the
MVP — shared tests, one vendored-tarball process) vs. a separate repo.
