#!/usr/bin/env node
/**
 * scripts/verify-no-markers.mjs
 *
 * Post-build prod-footprint proof:
 *   1. Grep .next/static/** and .next/server/** for the full 12-char marker
 *      sequence (U+2060 + 10 body chars from {U+200B,U+200C,U+200D,U+2060} +
 *      U+200B) and for the live-package symbols (LexenLive, __LEXEN_LIVE__,
 *      @thelol3882/lexen-live).  We match the COMPLETE marker pattern rather
 *      than bare individual codepoints to avoid false positives from legitimate
 *      occurrences of lone U+200B in third-party polyfills (e.g. core-js trim).
 *   2. Assert .next/standalone/node_modules does NOT contain @thelol3882/lexen-live.
 *   3. Exit 0 on a clean build; exit 1 with a descriptive message on ANY hit.
 *
 * Windows-friendly: uses only Node.js built-in APIs, no external deps.
 * Run after `next build` in the app directory:
 *   node scripts/verify-no-markers.mjs [--next-dir /path/to/.next]
 *
 * By default looks for .next/ in process.cwd().
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Parse --next-dir argument or fall back to cwd/.next.
 * Windows paths with spaces are handled by the shell before we see them.
 */
function parseNextDir() {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf('--next-dir');
  if (flagIdx !== -1 && args[flagIdx + 1]) {
    return args[flagIdx + 1];
  }
  return join(process.cwd(), '.next');
}

const NEXT_DIR = parseNextDir();

/**
 * Directories inside .next to scan for sentinel/symbol hits.
 * We check both the static chunk directory and the server-side bundles.
 */
const SCAN_DIRS = [
  join(NEXT_DIR, 'static'),
  join(NEXT_DIR, 'server'),
];

/**
 * Directory that must NOT contain @thelol3882/lexen-live.
 */
const STANDALONE_LIVE_PKG = join(
  NEXT_DIR,
  'standalone',
  'node_modules',
  '@thelol3882',
  'lexen-live'
);

// ---------------------------------------------------------------------------
// Marker pattern (MUST NOT appear in prod output)
// From src/shared/markers-spec.ts — replicated here so this script has zero
// imports and works even before the package is built.
//
// Marker format (12 chars total, always):
//   Position 0   : U+2060 WORD JOINER          (MARKER_START / header sentinel)
//   Positions 1-10: 10 × one of the 4 ALPHABET  (body — 2 bits per char)
//     U+200B ZERO-WIDTH SPACE       (0b00)
//     U+200C ZERO-WIDTH NON-JOINER  (0b01)
//     U+200D ZERO-WIDTH JOINER      (0b10)
//     U+2060 WORD JOINER            (0b11)
//   Position 11  : U+200B ZERO-WIDTH SPACE      (MARKER_END / tail sentinel)
//
// We match the FULL 12-char sequence rather than bare individual codepoints
// to avoid false positives from legitimate occurrences of these characters
// in third-party polyfills (e.g. core-js trim() contains a lone U+200B in
// its whitespace character class, which is NOT a lexen-live marker).
// ---------------------------------------------------------------------------

/**
 * Regex that matches one complete 12-character lexen-live marker:
 *   U+2060 (MARKER_START)
 *   + exactly 10 chars from the 4-codepoint alphabet {U+200B, U+200C, U+200D, U+2060}
 *   + U+200B (MARKER_END)
 *
 * Any hit in a prod bundle is a genuine violation — this sequence cannot
 * appear by coincidence in compiled JavaScript/CSS/HTML output.
 */
const MARKER_REGEX = /⁠[​‌‍⁠]{10}​/;

/**
 * Plain-text symbols that must not appear in prod bundles.
 */
const SYMBOL_STRINGS = [
  'LexenLive',
  '__LEXEN_LIVE__',
  '@thelol3882/lexen-live',
];

// ---------------------------------------------------------------------------
// File extensions to scan
// (binary formats like .woff2/.ico etc. skip codepoint scanning entirely)
//
// NOTE: '.map' (sourcemap) files are intentionally EXCLUDED.
// Sourcemaps embed a `sourcesContent` array that contains the ORIGINAL source
// text of every module, including app code that imports from @lexen/live behind
// a dead prod-gate branch (e.g. `import('@thelol3882/lexen-live/client')`).
// The executable .js counterpart for that chunk contains zero live-package
// symbols — the import is DCE'd — but the sourcemap's sourcesContent faithfully
// reproduces the original TypeScript, causing a false FAIL on every clean build.
// Sourcemaps are non-executed debugging artifacts; they cannot "run" marker
// code in production. The meaningful guarantee — that no marker codepoints or
// live-package symbols survive into executable output — is fully covered by
// scanning the corresponding .js/.mjs/.cjs/.css/.html artifacts.
// ---------------------------------------------------------------------------
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs',
  '.ts', '.tsx',
  '.json', '.jsonc',
  // '.map' — excluded: sourcemaps contain sourcesContent with original source
  //           text; scanning them produces false positives for symbol strings.
  '.html', '.css', '.txt',
  '.wasm', // wasm binary: won't match UTF-8 strings, but we include for symbol scan
]);

// ---------------------------------------------------------------------------
// Recursive file walker (no external deps, Windows-path-safe)
// ---------------------------------------------------------------------------

/**
 * Yields absolute file paths under `dir`, depth-first.
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* walkDir(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Scanning helpers
// ---------------------------------------------------------------------------

/**
 * Read file as UTF-8 (errors are non-fatal — binary files may fail; we log and skip).
 * @param {string} filePath
 * @returns {string | null}
 */
function readTextSafe(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    // Binary or unreadable — skip
    return null;
  }
}

/**
 * Check whether `content` contains any of the given needles.
 * Returns the first matched needle, or null if none found.
 * @param {string} content
 * @param {readonly string[]} needles
 * @returns {string | null}
 */
function firstHit(content, needles) {
  for (const needle of needles) {
    if (content.includes(needle)) return needle;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

/** @type {Array<{file: string, reason: string}>} */
const violations = [];

let scannedFiles = 0;

for (const scanDir of SCAN_DIRS) {
  if (!existsSync(scanDir)) {
    console.log(`[verify-no-markers] Directory not found, skipping: ${scanDir}`);
    continue;
  }

  for (const filePath of walkDir(scanDir)) {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();

    // Skip non-text extensions for sentinel scanning
    if (!TEXT_EXTENSIONS.has(ext)) continue;

    const content = readTextSafe(filePath);
    if (content === null) continue;

    scannedFiles++;

    const relPath = relative(NEXT_DIR, filePath);

    // 1. Check for the full 12-char marker sequence (START + 10 body + END).
    //    Using the regex avoids false positives from lone U+200B / U+2060
    //    codepoints that appear legitimately in third-party polyfills.
    if (MARKER_REGEX.test(content)) {
      violations.push({
        file: relPath,
        reason: 'Contains full 12-char lexen-live marker sequence (U+2060 + 10 body chars + U+200B)',
      });
    }

    // 2. Check for live-package symbol strings
    const symHit = firstHit(content, SYMBOL_STRINGS);
    if (symHit !== null) {
      violations.push({
        file: relPath,
        reason: `Contains live-package symbol: "${symHit}"`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone node_modules check
// ---------------------------------------------------------------------------

if (existsSync(STANDALONE_LIVE_PKG)) {
  violations.push({
    file: relative(NEXT_DIR, STANDALONE_LIVE_PKG),
    reason: '@thelol3882/lexen-live found in .next/standalone/node_modules — must be devDependency only',
  });
} else {
  const standaloneRoot = join(NEXT_DIR, 'standalone', 'node_modules', '@thelol3882');
  if (existsSync(standaloneRoot)) {
    // Check for any lexen-live variant
    for (const entry of readdirSync(standaloneRoot, { withFileTypes: true })) {
      if (entry.name.includes('lexen-live')) {
        violations.push({
          file: relative(NEXT_DIR, join(standaloneRoot, entry.name)),
          reason: `@thelol3882/${entry.name} (lexen-live variant) found in .next/standalone/node_modules`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`[verify-no-markers] Scanned ${scannedFiles} files in ${SCAN_DIRS.map(d => relative(process.cwd(), d)).join(', ')}`);

if (violations.length === 0) {
  console.log('[verify-no-markers] PASS — no marker codepoints or live-package symbols found in prod build.');
  process.exit(0);
} else {
  console.error(`[verify-no-markers] FAIL — ${violations.length} violation(s) found:\n`);
  for (const { file, reason } of violations) {
    console.error(`  .next/${file}`);
    console.error(`    Reason: ${reason}\n`);
  }
  console.error('Prod build contains live-edit markers or symbols. Fix dev/prod gating before shipping.');
  process.exit(1);
}
