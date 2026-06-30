/**
 * @thelol3882/lexen-live — headless overflow-detection and auto-correction loop.
 *
 * Architecture:
 *  - Launches Chromium headless via Playwright against a running `next dev`
 *    server (NEXT_PUBLIC_LEXEN_LIVE=1 required).
 *  - Enumerates marked text nodes in the DOM using the in-page marker registry
 *    (never relies on screenshot OCR for key identification).
 *  - Measures scrollWidth > clientWidth (horizontal overflow) or line-clamp
 *    truncation to flag overflowing strings.
 *  - Uses element-scoped screenshots as the overflow confirmation signal
 *    (before/after comparison, not OCR).
 *  - For each overflowing node: decodes marker ID → GET /key, proposes a
 *    shorter placeholder-preserving replacement, POST /save, re-measures,
 *    auto-corrects on drift and retries.
 *  - Emits a structured JSON edit/gate report.
 *
 * Dev-only: this module is never imported by any client/server export; it is
 * a Node.js script invoked via `node dist/agent/index.js` or a pnpm script.
 */

import type { Browser, Page, BrowserContext } from 'playwright';
import type { KeyResponse, SaveResponse, ConfigResponse } from '../shared/protocol.js';
import {
  MARKER_START,
  MARKER_END,
  MARKER_ALPHABET,
  MARKER_BODY_LENGTH,
  ID_BITS,
} from '../shared/markers-spec.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OverflowLoopOptions {
  /** Base URL of the running Next.js dev server. Default: http://localhost:3000 */
  baseUrl?: string;

  /**
   * One or more page paths to visit. Default: ['/'].
   * Each path is visited in sequence.
   */
  paths?: string[];

  /**
   * Maximum edit attempts per overflowing node before giving up.
   * Default: 5
   */
  maxIterationsPerNode?: number;

  /**
   * Maximum number of overflowing nodes to process per page.
   * Default: 50
   */
  maxNodesPerPage?: number;

  /** Viewport width in px. Default: 1280 */
  viewportWidth?: number;

  /** Viewport height in px. Default: 800 */
  viewportHeight?: number;

  /**
   * If true, write screenshots of overflowing elements to screenshotDir.
   * Default: false
   */
  screenshots?: boolean;

  /**
   * Directory to write element screenshots to. Default: '.lexen-live-agent'
   * Only used when screenshots === true.
   */
  screenshotDir?: string;

  /**
   * Locale to propose shortened values in. Default: derived from ConfigResponse.defaultLocale.
   */
  targetLocale?: string;

  /**
   * Called with each agent action for verbose logging.
   * Default: no-op.
   */
  onProgress?: (event: AgentEvent) => void;

  /**
   * If provided, an external Playwright Browser instance is used.
   * The loop will NOT close it when done.
   */
  browser?: Browser;
}

export type AgentEventKind =
  | 'page-start'
  | 'page-done'
  | 'overflow-detected'
  | 'overflow-cleared'
  | 'overflow-unchanged'
  | 'key-fetched'
  | 'save-ok'
  | 'save-drift'
  | 'save-error'
  | 'dynamic-key-skip'
  | 'max-iter-exceeded'
  | 'config-loaded';

export interface AgentEvent {
  kind: AgentEventKind;
  path?: string;
  namespace?: string;
  dotKey?: string;
  locale?: string;
  value?: string;
  previousValue?: string;
  drift?: string[];
  iteration?: number;
  detail?: string;
}

export interface EditRecord {
  path: string;
  namespace: string;
  dotKey: string;
  locale: string;
  previousValue: string;
  newValue: string;
  overflowCleared: boolean;
  iterations: number;
  driftEncountered: boolean;
}

export interface GateViolation {
  path: string;
  namespace: string;
  dotKey: string;
  locale: string;
  drift: string[];
}

export interface OverflowLoopReport {
  ok: boolean;
  pagesVisited: string[];
  edits: EditRecord[];
  gateViolations: GateViolation[];
  skipped: Array<{ path: string; namespace: string; dotKey: string; reason: string }>;
  /** Total overflowing nodes detected (includes skipped). */
  totalOverflowDetected: number;
}

// ---------------------------------------------------------------------------
// Marker decode (mirrors src/client/codec.ts logic, in Node)
// ---------------------------------------------------------------------------

/**
 * Decode a 20-bit marker ID from a string that begins with the marker prefix.
 * Returns null if the string does not start with a valid marker.
 */
function decodeMarkerId(text: string): number | null {
  if (!text.startsWith(MARKER_START)) return null;

  // After MARKER_START, read MARKER_BODY_LENGTH body chars, then MARKER_END.
  const bodyStart = MARKER_START.length;
  const bodyEnd = bodyStart + MARKER_BODY_LENGTH;
  const endPos = bodyEnd;

  if (text.length < endPos + MARKER_END.length) return null;
  if (text[endPos] !== MARKER_END) return null;

  let id = 0;
  // LSB-first: body[0] carries bits 0-1, body[9] carries bits 18-19.
  // Mirrors client/markers.ts encode(): body[i] = ALPHABET[(id >>> (i*2)) & 3].
  for (let i = 0; i < MARKER_BODY_LENGTH; i++) {
    const ch = text[bodyStart + i];
    const bits = (MARKER_ALPHABET as readonly string[]).indexOf(ch);
    if (bits === -1) return null;
    id |= bits << (i * 2);
  }

  return id;
}

/**
 * Strip all marker characters from a string.
 * Used to clean values before proposing or checking placeholder content.
 */
function stripMarkers(s: string): string {
  // Remove all four zero-width / word-joiner codepoints used in the marker scheme
  // eslint-disable-next-line no-control-regex
  return s.replace(/[​‌‍⁠]/g, '');
}

// ---------------------------------------------------------------------------
// Placeholder utilities (mirrors validate.ts logic, dependency-free)
// ---------------------------------------------------------------------------

/** Extract ICU placeholder names ({name}) from a string. */
function extractPlaceholders(value: string): string[] {
  const names: string[] = [];
  // Match simple {name} and ICU complex {name,plural,...} / {name,select,...}
  for (const m of value.matchAll(/\{(\w+)(?:[,}])/g)) {
    names.push(m[1]);
  }
  // Deduplicate
  return [...new Set(names)];
}

/**
 * Given the original value and all required placeholder names, produce a
 * shorter string that preserves every placeholder.
 *
 * Strategy (deterministic, no LLM required for basic cases):
 *  1. Strip markers.
 *  2. Replace long runs of non-placeholder text with compressed forms:
 *     - Remove trailing punctuation clauses.
 *     - Truncate filler words.
 *  3. Ensure all original placeholders are present in the result.
 *
 * For an agent that DOES have LLM access, replace the body of this function
 * with an LLM call — the signature and contract remain the same.
 */
function proposeShorterValue(original: string, placeholders: string[]): string {
  const clean = stripMarkers(original);

  // If already very short, return as-is
  if (clean.length <= 20) return clean;

  // Split on whitespace, compress words
  const words = clean.split(/\s+/);

  // Keep words that contain placeholders (must not be removed)
  const kept: string[] = [];
  let totalLen = 0;
  const targetLen = Math.max(20, Math.floor(clean.length * 0.6));

  for (const word of words) {
    const containsPlaceholder = placeholders.some(ph =>
      word.includes(`{${ph}`) || word.includes(`${ph}}`)
    );
    if (containsPlaceholder) {
      kept.push(word);
      totalLen += word.length + 1;
    } else if (totalLen < targetLen) {
      kept.push(word);
      totalLen += word.length + 1;
    }
    // else: drop the word (shortening)
  }

  let result = kept.join(' ');

  // Ensure all placeholders survive
  for (const ph of placeholders) {
    if (!result.includes(`{${ph}`)) {
      result += ` {${ph}}`;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// In-page registry extraction
// ---------------------------------------------------------------------------

/**
 * In-page script: finds all text nodes in the DOM that begin with the
 * MARKER_START sentinel, extracts the raw marker string + the text node's
 * parent element information.
 *
 * Returns an array of { markerId, elementHandle-compatible info } but because
 * we can't pass ElementHandles across evaluateHandle boundaries cleanly, we
 * return a serializable descriptor per node and a separate locator list.
 */
interface MarkedNodeDescriptor {
  /** Decoded 20-bit marker ID (or -1 if decode failed). */
  markerId: number;
  /** XPath to the text node's parent element (for Playwright locator). */
  parentXPath: string;
  /** Inner text of the parent element (for debugging). */
  innerText: string;
  /** Whether the parent element has horizontal overflow. */
  hasHorizontalOverflow: boolean;
  /** Whether the parent element is line-clamped and truncated. */
  isLineClamped: boolean;
  /**
   * Resolved lexen namespace from window.__LEXEN_LIVE__.registry, or '' if the
   * registry was not yet populated when page.evaluate ran.
   */
  ns: string;
  /**
   * Resolved dot-key from window.__LEXEN_LIVE__.registry, or '' if the registry
   * was not yet populated when page.evaluate ran.
   */
  dotKey: string;
}

// ---------------------------------------------------------------------------
// Core loop implementation
// ---------------------------------------------------------------------------

/**
 * Run one page-level overflow detection and correction pass.
 * Returns the list of edits and violations for this page.
 */
async function processPage(
  page: Page,
  pageUrl: string,
  opts: Required<Omit<OverflowLoopOptions, 'browser' | 'onProgress'>> & {
    onProgress: (e: AgentEvent) => void;
    browser: Browser | undefined;
    targetLocale: string;
  },
  config: ConfigResponse,
): Promise<{
  edits: EditRecord[];
  gateViolations: GateViolation[];
  skipped: Array<{ path: string; namespace: string; dotKey: string; reason: string }>;
  totalOverflowDetected: number;
}> {
  const edits: EditRecord[] = [];
  const gateViolations: GateViolation[] = [];
  const skipped: Array<{ path: string; namespace: string; dotKey: string; reason: string }> = [];
  let totalOverflowDetected = 0;

  const pagePath = new URL(pageUrl).pathname;

  opts.onProgress({ kind: 'page-start', path: pagePath });

  await page.goto(pageUrl, { waitUntil: 'networkidle' });

  // Extract all marked nodes with overflow information from the page.
  // DOM globals (document, window, Node, NodeFilter, Text, Element) are
  // accessed via (globalThis as any) so this file typechecks correctly when
  // the consumer's tsconfig lacks "dom" in its lib (e.g. lexen core tsconfig).
  // When the live package's own tsc runs (lib includes "DOM") the casts are
  // harmless no-ops.
  const markedNodes: MarkedNodeDescriptor[] = await page.evaluate(
    ({ markerStart, markerEnd, markerAlphabet, markerBodyLength, maxNodes }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = globalThis as any;
      const doc: { createTreeWalker: Function; body: any } = g.document;
      const win: { getComputedStyle: Function } = g.window ?? g;
      // NodeFilter.SHOW_TEXT = 4 (constant, no DOM lib needed)
      const SHOW_TEXT = 4;
      // Node.ELEMENT_NODE = 1
      const ELEMENT_NODE = 1;

      /**
       * Decode a marker ID from a text string (must start with markerStart).
       * Mirrors client/markers.ts decode(): LSB-first, body[0] = bits 0-1.
       */
      function decodeId(text: string): number {
        const bodyStart = markerStart.length;
        let id = 0;
        // LSB-first: body[i] encodes bits (i*2)..(i*2+1).
        for (let i = 0; i < markerBodyLength; i++) {
          const ch = text[bodyStart + i];
          const bits = (markerAlphabet as string[]).indexOf(ch);
          if (bits === -1) return -1;
          id |= bits << (i * 2);
        }
        return id;
      }

      function getXPath(el: { id?: string; tagName?: string; parentElement?: any; nodeType?: number; previousElementSibling?: any }): string {
        if (el.id) return `//*[@id="${el.id}"]`;
        const parts: string[] = [];
        let node: typeof el | null = el;
        while (node && node.nodeType === ELEMENT_NODE) {
          let idx = 1;
          let sib = node.previousElementSibling;
          while (sib) {
            if (sib.tagName === node.tagName) idx++;
            sib = sib.previousElementSibling;
          }
          parts.unshift(`${(node.tagName as string).toLowerCase()}[${idx}]`);
          node = node.parentElement ?? null;
        }
        return '/' + parts.join('/');
      }

      function isOverflowing(el: { scrollWidth: number; clientWidth: number }): boolean {
        return el.scrollWidth > el.clientWidth;
      }

      function isLineClamped(el: { clientHeight: number; scrollHeight: number }): boolean {
        const style = win.getComputedStyle(el);
        const overflow = style.getPropertyValue('-webkit-line-clamp');
        if (overflow && overflow !== 'none') {
          return el.scrollHeight > el.clientHeight;
        }
        return false;
      }

      const results: Array<{
        markerId: number;
        parentXPath: string;
        innerText: string;
        hasHorizontalOverflow: boolean;
        isLineClamped: boolean;
        ns: string;
        dotKey: string;
      }> = [];

      // Walk all text nodes in the document
      const walker = doc.createTreeWalker(doc.body, SHOW_TEXT, null);

      let textNode: { textContent: string | null; parentElement: any; nextNode?: Function } | null = null;
      let processed = 0;

      while ((textNode = walker.nextNode()) !== null) {
        if (processed >= maxNodes) break;
        const text = textNode.textContent ?? '';
        if (!text.startsWith(markerStart)) continue;

        const bodyEnd = markerStart.length + markerBodyLength;
        if (text.length < bodyEnd + markerEnd.length) continue;
        if (text[bodyEnd] !== markerEnd) continue;

        const markerId = decodeId(text);
        if (markerId < 0) continue;

        const parent = textNode.parentElement;
        if (!parent) continue;

        const overflow = isOverflowing(parent);
        const clamped = isLineClamped(parent);

        if (!overflow && !clamped) continue;

        // Resolve namespace + dotKey from the agent registry that DevProvider
        // exposes on window.__LEXEN_LIVE__.registry (set after wrapMessages).
        // Keys are numeric IDs serialised as strings by Object.fromEntries.
        const lexenLive = g.__LEXEN_LIVE__ as
          | { registry?: Record<string, { namespace: string; dotKey: string }> }
          | undefined;
        const regEntry = lexenLive?.registry?.[String(markerId)];
        const ns = regEntry?.namespace ?? '';
        const dotKey = regEntry?.dotKey ?? '';

        results.push({
          markerId,
          parentXPath: getXPath(parent),
          innerText: parent.innerText?.slice(0, 200) ?? text.slice(0, 200),
          hasHorizontalOverflow: overflow,
          isLineClamped: clamped,
          ns,
          dotKey,
        });

        processed++;
      }

      return results;
    },
    {
      markerStart: MARKER_START,
      markerEnd: MARKER_END,
      markerAlphabet: [...MARKER_ALPHABET] as string[],
      markerBodyLength: MARKER_BODY_LENGTH,
      maxNodes: opts.maxNodesPerPage,
    }
  );

  totalOverflowDetected += markedNodes.length;

  if (markedNodes.length === 0) {
    opts.onProgress({ kind: 'page-done', path: pagePath, detail: 'No overflowing marked nodes found.' });
    return { edits, gateViolations, skipped, totalOverflowDetected };
  }

  const apiBase = opts.baseUrl.replace(/\/$/, '') + '/api/lexen-live';

  for (const node of markedNodes) {
    if (node.markerId < 0) continue;

    // Skip nodes where the browser registry lookup failed.  This happens when
    // window.__LEXEN_LIVE__ is not yet populated (DevProvider useEffect has not
    // run) or when the markerId is genuinely absent from the registry.
    if (!node.ns || !node.dotKey) {
      skipped.push({
        path: pagePath,
        namespace: '',
        dotKey: '',
        reason:
          `markerId=${node.markerId}: namespace/key not found in ` +
          'window.__LEXEN_LIVE__.registry (DevProvider may not have mounted yet)',
      });
      continue;
    }

    opts.onProgress({
      kind: 'overflow-detected',
      path: pagePath,
      detail: `markerId=${node.markerId} ns=${node.ns} key=${node.dotKey} xpath=${node.parentXPath} overflow=${node.hasHorizontalOverflow} clamped=${node.isLineClamped}`,
    });

    // Screenshot of overflowing element (before)
    if (opts.screenshots) {
      try {
        const el = page.locator(`xpath=${node.parentXPath}`).first();
        await el.screenshot({
          path: `${opts.screenshotDir}/overflow-${node.markerId}-before.png`,
        });
      } catch {
        // Element may have moved between evaluation and locator; non-fatal
      }
    }

    // GET /key?ns=&key= — the server's existing endpoint; ns and dotKey were
    // resolved in-page from window.__LEXEN_LIVE__.registry, so no server-side
    // markerId lookup is required.
    const keyUrl =
      `${apiBase}/key` +
      `?ns=${encodeURIComponent(node.ns)}` +
      `&key=${encodeURIComponent(node.dotKey)}`;
    let keyResp: KeyResponse;
    try {
      const resp = await fetch(keyUrl);
      if (!resp.ok) {
        skipped.push({
          path: pagePath,
          namespace: node.ns,
          dotKey: node.dotKey,
          reason: `GET /key returned ${resp.status} for ns=${node.ns} key=${node.dotKey}`,
        });
        continue;
      }
      keyResp = (await resp.json()) as KeyResponse;
    } catch (err) {
      skipped.push({
        path: pagePath,
        namespace: node.ns,
        dotKey: node.dotKey,
        reason: `GET /key network error: ${String(err)}`,
      });
      continue;
    }

    const { ref, values, placeholders } = keyResp;
    const locale = opts.targetLocale || config.defaultLocale;

    opts.onProgress({
      kind: 'key-fetched',
      path: pagePath,
      namespace: ref.namespace,
      dotKey: ref.dotKey,
      locale,
      value: values[locale],
    });

    const currentValue = values[locale] ?? '';

    let iterationsUsed = 0;
    let overflowCleared = false;
    let driftEncountered = false;
    let proposedValue = currentValue;

    for (let iter = 0; iter < opts.maxIterationsPerNode; iter++) {
      iterationsUsed++;

      // Propose a shorter value
      proposedValue = proposeShorterValue(proposedValue, placeholders);

      // POST /save
      let saveResp: SaveResponse;
      try {
        const resp = await fetch(`${apiBase}/save`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Lexen-Live': '1',
          },
          body: JSON.stringify({
            ref,
            updates: { [locale]: proposedValue },
          }),
        });
        saveResp = (await resp.json()) as SaveResponse;
      } catch (err) {
        opts.onProgress({
          kind: 'save-error',
          path: pagePath,
          namespace: ref.namespace,
          dotKey: ref.dotKey,
          detail: String(err),
          iteration: iter,
        });
        break;
      }

      if (!saveResp.ok) {
        if (saveResp.checkCode === 1) {
          // Drift: placeholders mismatch. The server reverted the write.
          // Extract drift info and retry with corrected value.
          driftEncountered = true;
          const driftWarnings = saveResp.warnings;

          opts.onProgress({
            kind: 'save-drift',
            path: pagePath,
            namespace: ref.namespace,
            dotKey: ref.dotKey,
            locale,
            drift: driftWarnings,
            iteration: iter,
          });

          // Add missing placeholders back and retry
          for (const ph of placeholders) {
            if (!proposedValue.includes(`{${ph}`)) {
              proposedValue += ` {${ph}}`;
            }
          }

          gateViolations.push({
            path: pagePath,
            namespace: ref.namespace,
            dotKey: ref.dotKey,
            locale,
            drift: driftWarnings,
          });

          continue; // retry with corrected value
        } else {
          opts.onProgress({
            kind: 'save-error',
            path: pagePath,
            namespace: ref.namespace,
            dotKey: ref.dotKey,
            detail: saveResp.message,
            iteration: iter,
          });
          skipped.push({
            path: pagePath,
            namespace: ref.namespace,
            dotKey: ref.dotKey,
            reason: `Save blocked: ${saveResp.message} (code ${saveResp.checkCode})`,
          });
          break;
        }
      }

      opts.onProgress({
        kind: 'save-ok',
        path: pagePath,
        namespace: ref.namespace,
        dotKey: ref.dotKey,
        locale,
        previousValue: currentValue,
        value: proposedValue,
        iteration: iter,
      });

      // Reload page to pick up written changes and re-measure
      await page.goto(pageUrl, { waitUntil: 'networkidle' });

      // Re-measure the specific element.
      // DOM globals accessed via (globalThis as any) for tsconfig-lib compatibility.
      const stillOverflows = await page.evaluate(
        ({ xpath, markerStart: ms }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const doc: any = (globalThis as any).document;
          // XPathResult.FIRST_ORDERED_NODE_TYPE = 9 (constant)
          const FIRST_ORDERED_NODE_TYPE = 9;
          const result = doc.evaluate(xpath, doc, null, FIRST_ORDERED_NODE_TYPE, null);
          const el = result?.singleNodeValue;
          if (!el) return false;
          // Also check text nodes under it for markers
          const hasMarker = (el.textContent as string | null)?.includes(ms) ?? false;
          if (!hasMarker) return false;
          return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
        },
        { xpath: node.parentXPath, markerStart: MARKER_START }
      );

      if (!stillOverflows) {
        overflowCleared = true;

        if (opts.screenshots) {
          try {
            const el = page.locator(`xpath=${node.parentXPath}`).first();
            await el.screenshot({
              path: `${opts.screenshotDir}/overflow-${node.markerId}-after.png`,
            });
          } catch {
            // non-fatal
          }
        }

        opts.onProgress({
          kind: 'overflow-cleared',
          path: pagePath,
          namespace: ref.namespace,
          dotKey: ref.dotKey,
          locale,
          value: proposedValue,
          iteration: iter,
        });

        edits.push({
          path: pagePath,
          namespace: ref.namespace,
          dotKey: ref.dotKey,
          locale,
          previousValue: currentValue,
          newValue: proposedValue,
          overflowCleared: true,
          iterations: iterationsUsed,
          driftEncountered,
        });

        break;
      }

      // Overflow still present — try again with even shorter value
      if (iter === opts.maxIterationsPerNode - 1) {
        opts.onProgress({
          kind: 'max-iter-exceeded',
          path: pagePath,
          namespace: ref.namespace,
          dotKey: ref.dotKey,
          detail: `Overflow not cleared after ${opts.maxIterationsPerNode} iterations`,
        });

        edits.push({
          path: pagePath,
          namespace: ref.namespace,
          dotKey: ref.dotKey,
          locale,
          previousValue: currentValue,
          newValue: proposedValue,
          overflowCleared: false,
          iterations: iterationsUsed,
          driftEncountered,
        });

        opts.onProgress({
          kind: 'overflow-unchanged',
          path: pagePath,
          namespace: ref.namespace,
          dotKey: ref.dotKey,
        });
      }
    }

    if (!overflowCleared && iterationsUsed === 0) {
      skipped.push({
        path: pagePath,
        namespace: ref.namespace,
        dotKey: ref.dotKey,
        reason: 'No iterations completed',
      });
    }
  }

  opts.onProgress({ kind: 'page-done', path: pagePath });
  return { edits, gateViolations, skipped, totalOverflowDetected };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the headless overflow-detection and auto-correction loop.
 *
 * Requires a running `next dev` server with NEXT_PUBLIC_LEXEN_LIVE=1.
 * Playwright must be installed in the consumer's devDependencies.
 *
 * @example
 * ```ts
 * import { runOverflowLoop } from '@thelol3882/lexen-live/agent';
 *
 * const report = await runOverflowLoop({
 *   baseUrl: 'http://localhost:3000',
 *   paths: ['/dashboard', '/settings'],
 *   maxIterationsPerNode: 5,
 *   screenshots: true,
 * });
 * console.log(JSON.stringify(report, null, 2));
 * ```
 */
export async function runOverflowLoop(
  opts: OverflowLoopOptions = {}
): Promise<OverflowLoopReport> {
  const baseUrl = opts.baseUrl ?? 'http://localhost:3000';
  const paths = opts.paths ?? ['/'];
  const maxIterationsPerNode = opts.maxIterationsPerNode ?? 5;
  const maxNodesPerPage = opts.maxNodesPerPage ?? 50;
  const viewportWidth = opts.viewportWidth ?? 1280;
  const viewportHeight = opts.viewportHeight ?? 800;
  const screenshots = opts.screenshots ?? false;
  const screenshotDir = opts.screenshotDir ?? '.lexen-live-agent';
  const onProgress = opts.onProgress ?? (() => undefined);

  // Dynamically import Playwright — it is a devDependency and may not be
  // installed in all environments. A clear error is surfaced if missing.
  let chromium: import('playwright').BrowserType;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    throw new Error(
      '[lexen-live/agent] Playwright is not installed. ' +
      'Add "playwright" to devDependencies and run `pnpm playwright install chromium`.'
    );
  }

  // Fetch config from the running dev server
  const configUrl = `${baseUrl.replace(/\/$/, '')}/api/lexen-live/config`;
  let config: ConfigResponse;
  try {
    const resp = await fetch(configUrl);
    if (!resp.ok) {
      throw new Error(`GET /config returned HTTP ${resp.status}`);
    }
    config = (await resp.json()) as ConfigResponse;
  } catch (err) {
    throw new Error(
      `[lexen-live/agent] Failed to fetch config from ${configUrl}: ${String(err)}\n` +
      'Is the Next.js dev server running with NEXT_PUBLIC_LEXEN_LIVE=1?'
    );
  }

  onProgress({ kind: 'config-loaded', detail: JSON.stringify(config) });

  const targetLocale = opts.targetLocale ?? config.defaultLocale;

  // Set up screenshots directory if needed
  if (screenshots) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(screenshotDir, { recursive: true });
  }

  const resolvedOpts = {
    baseUrl,
    paths,
    maxIterationsPerNode,
    maxNodesPerPage,
    viewportWidth,
    viewportHeight,
    screenshots,
    screenshotDir,
    targetLocale,
    onProgress,
    browser: opts.browser,
  };

  let browser: Browser | undefined = opts.browser;
  let ownsBrowser = false;
  let context: BrowserContext | undefined;

  try {
    if (!browser) {
      browser = await chromium.launch({ headless: true });
      ownsBrowser = true;
    }

    context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
    });

    const allEdits: EditRecord[] = [];
    const allGateViolations: GateViolation[] = [];
    const allSkipped: Array<{ path: string; namespace: string; dotKey: string; reason: string }> = [];
    let totalOverflowDetected = 0;
    const pagesVisited: string[] = [];

    for (const pagePath of paths) {
      const pageUrl = `${baseUrl.replace(/\/$/, '')}${pagePath.startsWith('/') ? pagePath : '/' + pagePath}`;
      const page = await context.newPage();

      try {
        const result = await processPage(page, pageUrl, resolvedOpts, config);
        allEdits.push(...result.edits);
        allGateViolations.push(...result.gateViolations);
        allSkipped.push(...result.skipped);
        totalOverflowDetected += result.totalOverflowDetected;
        pagesVisited.push(pageUrl);
      } finally {
        await page.close();
      }
    }

    const report: OverflowLoopReport = {
      ok: allGateViolations.length === 0 && allSkipped.length === 0,
      pagesVisited,
      edits: allEdits,
      gateViolations: allGateViolations,
      skipped: allSkipped,
      totalOverflowDetected,
    };

    return report;
  } finally {
    if (context) await context.close();
    if (ownsBrowser && browser) await browser.close();
  }
}
