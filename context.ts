/**
 * `lexen context` — static translation context for the empty `""` values a
 * translator (AI agent or human) has to fill.
 *
 * Reuses the extract AST walk's namespace resolution (via the `onKeyContext`
 * sink) and, for every literal `t('key')`, captures the wrapping JSX element +
 * its style props. On a Mantine codebase typography/sizing live in JSX props
 * (`fz`, `size`, `tt`, `fw`), so the AST sees the *space budget* of each string
 * — enough to tell a translator "keep this short" before they write a word.
 *
 * Pure static analysis: no runtime, no Provider. Output is consumed by a
 * translator agent; lexen's `check` (placeholder drift) gates the result.
 */
import path from 'path';

import ts from 'typescript';

import {extractAll} from './extract/index.js';
import {getNestedValue, readNamespace} from './locales.js';
import type {Config, ExtractOptions, JsonObject} from './types.js';
import {c, log} from './util/log.js';

export type SpaceBudget = 'tight' | 'medium' | 'roomy';

export interface KeyContext {
    key: string;
    namespace: string;
    /** `relFile:line:col` (relative to srcDir, matching lexen's other reporters). */
    callSite: string;
    file: string;
    line: number;
    column: number;
    /** Enclosing component/function name, when one can be named. */
    component: string | null;
    jsx: {
        /** Wrapping JSX element tag (e.g. `Text`, `Button`), or null if not in JSX. */
        element: string | null;
        /** JSX attribute the call sits in (e.g. `aria-label`, `placeholder`), if any. */
        attribute: string | null;
        /** Curated style props read off the wrapping element. */
        props: Record<string, string | number | boolean>;
        /** Heuristic role inferred from element + props (see inferRole). */
        role: string;
        /** How much room the string has — guidance for translation length. */
        spaceBudget: SpaceBudget;
    };
    /** ICU placeholder vars the translation must preserve (from the source value). */
    placeholders: string[];
    /** How many call sites use this key (context is taken from the first). */
    usageCount: number;
    /** Current value per locale; empty `""` marks what still needs filling. */
    source: Record<string, string>;
}

// Style/layout props worth surfacing — the ones that carry length signal.
// Everything else on the element is noise for a translator.
const STYLE_PROPS = new Set([
    'fz', 'fw', 'size', 'tt', 'lts', 'lh', 'ta', 'c', 'truncate',
    'lineClamp', 'w', 'maw', 'miw', 'variant', 'order', 'span', 'ff',
]);

// Tags whose text is a control label — always tight.
const BUTTON_TAGS = new Set([
    'Button', 'ActionIcon', 'Anchor', 'NavLink', 'MenuItem', 'UnstyledButton', 'Chip', 'Badge', 'Pill',
]);

// Attributes whose value is read by assistive tech / tooltips, not laid out
// in the visible flow — length is far less constrained.
const A11Y_ATTRS = new Set(['aria-label', 'aria-description', 'alt', 'title']);

function toRel(config: Config, absFile: string): string {
    const rel = path.relative(config.absSrcDir, path.normalize(absFile));
    return rel.split(path.sep).join('/');
}

function attrValue(init: ts.JsxAttribute['initializer']): string | number | boolean | undefined {
    if (init === undefined) return true; // bare prop → boolean true
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression) {
        const e = init.expression;
        if (ts.isNumericLiteral(e)) return Number(e.text);
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
        if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
        // Negative numeric literals, e.g. lts={-0.02}.
        if (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)) {
            const n = Number(e.operand.text);
            return e.operator === ts.SyntaxKind.MinusToken ? -n : n;
        }
    }
    return undefined;
}

type ElementNode = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

/**
 * Walk up from the `t(...)` call to the JSX element wrapping it. Returns the
 * element node (which carries tagName + attributes) and, if the call sits
 * inside a JSX attribute, that attribute's name. Stops at a function boundary
 * so a call not inside any JSX (e.g. `const label = t('x')`) returns null.
 */
function findEnclosing(call: ts.Node): {el: ElementNode | null; attribute: string | null} {
    let n: ts.Node = call;
    let attribute: string | null = null;
    while (n.parent) {
        const p = n.parent;
        if (ts.isJsxAttribute(p)) attribute = p.name.getText();
        if (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) return {el: p, attribute};
        if (ts.isJsxElement(p)) return {el: p.openingElement, attribute};
        if (ts.isFunctionLike(p)) break;
        n = p;
    }
    return {el: null, attribute};
}

function collectProps(el: ElementNode): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const prop of el.attributes.properties) {
        if (!ts.isJsxAttribute(prop)) continue;
        const name = prop.name.getText();
        if (!STYLE_PROPS.has(name)) continue;
        const v = attrValue(prop.initializer);
        if (v !== undefined) out[name] = v;
    }
    return out;
}

/** True if any JSX ancestor within a few hops is a button-like control. */
function inButton(call: ts.Node): boolean {
    let n: ts.Node | undefined = call;
    for (let hops = 0; n && hops < 8; hops++, n = n.parent) {
        if (ts.isJsxElement(n) && BUTTON_TAGS.has(n.openingElement.tagName.getText())) return true;
        if (ts.isJsxSelfClosingElement(n) && BUTTON_TAGS.has(n.tagName.getText())) return true;
    }
    return false;
}

function enclosingComponent(call: ts.Node): string | null {
    let n: ts.Node | undefined = call;
    while (n) {
        if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
        if (
            (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
            n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)
        ) {
            return n.parent.name.text;
        }
        n = n.parent;
    }
    return null;
}

/**
 * Heuristic role + space budget. Signals, in priority order:
 *   - a11y / tooltip attributes → length barely constrained (roomy)
 *   - placeholder / field labels → medium / tight
 *   - button-like control → tight
 *   - tiny + uppercase → eyebrow label (tight)
 *   - large or bold → heading (tight — headings stay short)
 *   - tiny → caption (tight)
 *   - otherwise → body (medium)
 */
function inferRole(
    tag: string | null,
    props: Record<string, string | number | boolean>,
    attribute: string | null,
    isButton: boolean,
): {role: string; spaceBudget: SpaceBudget} {
    if (attribute && A11Y_ATTRS.has(attribute)) return {role: 'a11y-label', spaceBudget: 'roomy'};
    if (attribute === 'placeholder') return {role: 'placeholder', spaceBudget: 'medium'};
    if (attribute === 'label' || attribute === 'description' || attribute === 'error') {
        return {role: `field-${attribute}`, spaceBudget: attribute === 'description' ? 'roomy' : 'tight'};
    }
    if (isButton || (tag !== null && BUTTON_TAGS.has(tag))) return {role: 'button', spaceBudget: 'tight'};

    const fz = typeof props.fz === 'number' ? props.fz : undefined;
    const size = typeof props.size === 'string' ? props.size : undefined;
    const fw = typeof props.fw === 'number' ? props.fw : undefined;
    const upper = props.tt === 'uppercase';
    const ff = typeof props.ff === 'string' ? props.ff : '';
    const small = (fz !== undefined && fz <= 12) || size === 'xs';
    const large = (fz !== undefined && fz >= 18) || size === 'lg' || size === 'xl' || ff.includes('display');

    if (upper && small) return {role: 'eyebrow-label', spaceBudget: 'tight'};
    if (large || (fw !== undefined && fw >= 700)) return {role: 'heading', spaceBudget: 'tight'};
    if (small) return {role: 'caption', spaceBudget: 'tight'};
    return {role: 'body', spaceBudget: 'medium'};
}

/** Pull ICU placeholder var names from a value (`{n}`, `{count, plural, …}`). */
function extractPlaceholders(value: string): string[] {
    const out = new Set<string>();
    const re = /\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) out.add(m[1]);
    return [...out];
}

export interface ContextOptions {
    featureFilter?: string | null;
    /** Only emit keys with at least one empty `""` locale value. */
    untranslatedOnly?: boolean;
}

interface RawContext {
    key: string;
    namespace: string;
    file: string;
    line: number;
    column: number;
    component: string | null;
    element: string | null;
    attribute: string | null;
    props: Record<string, string | number | boolean>;
    role: string;
    spaceBudget: SpaceBudget;
    usageCount: number;
}

export function collectKeyContexts(config: Config, options: ContextOptions = {}): KeyContext[] {
    const {featureFilter = null, untranslatedOnly = false} = options;

    // First call site per (namespace, key) wins the context; later ones bump count.
    const raws = new Map<string, RawContext>();

    const onKeyContext: ExtractOptions['onKeyContext'] = (key, namespaces, call) => {
        const sf = call.getSourceFile();
        const {line, character} = ts.getLineAndCharacterOfPosition(sf, call.getStart(sf));
        const file = toRel(config, sf.fileName);
        const {el, attribute} = findEnclosing(call);
        const element = el ? el.tagName.getText() : null;
        const props = el ? collectProps(el) : {};
        const {role, spaceBudget} = inferRole(element, props, attribute, inButton(call));
        const component = enclosingComponent(call);

        for (const ns of namespaces) {
            const id = `${ns} ${key}`;
            const existing = raws.get(id);
            if (existing) {
                existing.usageCount++;
                continue;
            }
            raws.set(id, {
                key, namespace: ns, file, line: line + 1, column: character + 1,
                component, element, attribute, props, role, spaceBudget, usageCount: 1,
            });
        }
    };

    extractAll(config, {featureFilter, onKeyContext});

    // Second pass: attach source values + placeholders. Cache namespace reads
    // so each (namespace, locale) file is parsed at most once.
    const nsCache = new Map<string, JsonObject>();
    const readNs = (ns: string, locale: string): JsonObject => {
        const ck = `${ns} ${locale}`;
        let v = nsCache.get(ck);
        if (v === undefined) {
            v = readNamespace(config, ns, locale);
            nsCache.set(ck, v);
        }
        return v;
    };

    const out: KeyContext[] = [];
    for (const raw of raws.values()) {
        const source: Record<string, string> = {};
        for (const locale of config.locales) {
            const val = getNestedValue(readNs(raw.namespace, locale), raw.key);
            source[locale] = typeof val === 'string' ? val : '';
        }
        if (untranslatedOnly && !config.locales.some(l => source[l] === '')) continue;

        const seed = config.locales.map(l => source[l]).find(v => v !== '') ?? '';

        out.push({
            key: raw.key,
            namespace: raw.namespace,
            callSite: `${raw.file}:${raw.line}:${raw.column}`,
            file: raw.file,
            line: raw.line,
            column: raw.column,
            component: raw.component,
            jsx: {
                element: raw.element,
                attribute: raw.attribute,
                props: raw.props,
                role: raw.role,
                spaceBudget: raw.spaceBudget,
            },
            placeholders: extractPlaceholders(seed),
            usageCount: raw.usageCount,
            source,
        });
    }

    out.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key));
    return out;
}

function fmtProps(props: Record<string, string | number | boolean>): string {
    const parts = Object.entries(props).map(([k, v]) => (v === true ? k : `${k}=${v}`));
    return parts.length ? ` ${parts.join(' ')}` : '';
}

const BUDGET_COLOR: Record<SpaceBudget, string> = {
    tight: c.red,
    medium: c.yellow,
    roomy: c.green,
};

export function renderContextsHuman(contexts: KeyContext[], locales: string[]): void {
    if (contexts.length === 0) {
        log(`${c.green}No keys to show.${c.reset}`);
        return;
    }

    let currentNs = '';
    for (const ctx of contexts) {
        if (ctx.namespace !== currentNs) {
            currentNs = ctx.namespace;
            log(`\n${c.bold}${c.cyan}${currentNs}${c.reset}`);
        }

        const budget = BUDGET_COLOR[ctx.jsx.spaceBudget];
        const tag = ctx.jsx.element
            ? `<${ctx.jsx.element}${ctx.jsx.attribute ? ` ${ctx.jsx.attribute}=…` : ''}${fmtProps(ctx.jsx.props)}>`
            : '(not in JSX)';
        const count = ctx.usageCount > 1 ? ` ${c.dim}×${ctx.usageCount}${c.reset}` : '';

        log(`  ${c.bold}${ctx.key}${c.reset}  ${c.dim}[${ctx.jsx.role} ·${c.reset} ${budget}${ctx.jsx.spaceBudget}${c.reset}${c.dim}]${c.reset}${count}`);
        log(`    ${c.dim}${ctx.callSite}${c.reset}  ${c.dim}${tag}${c.reset}`);
        if (ctx.placeholders.length) {
            log(`    ${c.dim}vars:${c.reset} ${ctx.placeholders.map(p => `{${p}}`).join(' ')}`);
        }
        for (const locale of locales) {
            const v = ctx.source[locale] ?? '';
            if (v === '') {
                log(`    ${locale}: ${c.red}"" ← needs translation${c.reset}`);
            } else {
                log(`    ${locale}: ${c.green}"${v}"${c.reset}`);
            }
        }
    }
    log('');
}
