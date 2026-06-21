import ts from 'typescript';

import {resolveStringLiterals} from '../extract-resolver.js';
import type {AutoPreserved, NamespaceKeys} from '../types.js';
import {addKeyToNamespaces, callReceiverInfo, getCallReceiverName, templatePrefix} from './ast-utils.js';

export const BARE_NAMESPACE = '<<bare>>';

export function callToNamespaces(
    node: ts.Node,
    hookAliases: Set<string>,
    checker: ts.TypeChecker | null,
    onUnresolved?: (arg: ts.Node) => void,
): string[] | null {
    // `const t = await getTranslations('ns')` — unwrap the AwaitExpression so
    // server-side binders resolve exactly like their synchronous siblings.
    const call = ts.isAwaitExpression(node) ? node.expression : node;
    if (!ts.isCallExpression(call)) return null;
    const name = getCallReceiverName(call);
    if (!name || !hookAliases.has(name)) return null;

    if (call.arguments.length >= 1) {
        const arg = call.arguments[0];
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
            return [arg.text];
        }
        if (checker) {
            const resolved = resolveStringLiterals(arg, checker);
            if (resolved && resolved.length > 0) return resolved;
        }
        // Non-literal arg + resolver couldn't enumerate — RULES.md rule 1.
        // Callers probing a random CallExpression skip the callback.
        if (onUnresolved) onUnresolved(arg);
        return null;
    }

    // Bare `useTranslations()` — RULES.md rule 5. Sentinel triggers a validation
    // error at the call site; no keys extracted.
    return [BARE_NAMESPACE];
}

export function collectTranslationCall(
    node: ts.CallExpression,
    varToNamespaces: Map<string, Set<string>>,
    symToNamespaces: Map<ts.Symbol, Set<string>>,
    featureFilter: string | null,
    namespaceKeys: NamespaceKeys,
    autoPreserved: AutoPreserved,
    checker: ts.TypeChecker | null,
    onUnresolved?: (arg: ts.Node, namespaces: string[]) => void,
    /** Keys resolved from a dynamic hole (union/template/numeric) rather than a
     *  plain literal. They must mirror runtime values, so naming rules (rule 7)
     *  exempt them. */
    dynamicKeys?: NamespaceKeys,
): void {
    if (node.arguments.length < 1) return;

    const receiver = callReceiverInfo(node);
    if (!receiver) return;
    const {varName, varIdent, method} = receiver;

    // Symbol-based lookup resolves the exact declaration in scope. With a
    // resolvable symbol we must NOT fall back to name-keyed varToNamespaces —
    // the fallback would leak bindings across scopes sharing a variable name
    // (e.g. a parent's hook-return `t` bleeding into a child component's
    // prop-received `t` when propFlow fails).
    let namespaces: Set<string> | undefined;
    let hadSymbol = false;
    if (checker && varIdent) {
        const sym = checker.getSymbolAtLocation(varIdent);
        if (sym) {
            hadSymbol = true;
            namespaces = symToNamespaces.get(sym);
        }
    }
    if (!namespaces && !hadSymbol) namespaces = varToNamespaces.get(varName);
    if (!namespaces || namespaces.size === 0) return;

    // BARE_NAMESPACE short-circuits — the call is already reported as invalid;
    // don't extract keys under a sentinel we'd have to strip later.
    if (namespaces.has(BARE_NAMESPACE)) return;

    const matchingNamespaces = [...namespaces].filter(
        ns => !featureFilter || ns === featureFilter || ns === 'common',
    );
    if (matchingNamespaces.length === 0) return;

    if (method && !['rich', 'raw', 'markup'].includes(method)) return;

    const arg = node.arguments[0];

    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        addKeyToNamespaces(arg.text, matchingNamespaces, namespaceKeys);
        return;
    }

    // Template-literal with a static prefix — always auto-preserve the prefix
    // so existing values under it survive `--clean`, regardless of resolver.
    if (ts.isTemplateExpression(arg)) {
        const prefix = templatePrefix(arg.head.text);
        if (prefix) {
            for (const ns of matchingNamespaces) {
                if (!autoPreserved.has(ns)) autoPreserved.set(ns, new Set());
                autoPreserved.get(ns)!.add(prefix);
            }
        }
    }

    if (checker) {
        const resolved = resolveStringLiterals(arg, checker);
        if (resolved) {
            for (const key of resolved) {
                addKeyToNamespaces(key, matchingNamespaces, namespaceKeys);
                if (dynamicKeys) addKeyToNamespaces(key, matchingNamespaces, dynamicKeys);
            }
            return;
        }
    }
    // Non-literal arg the resolver couldn't see through (RULES.md rule 6).
    // AST-mode also lands here for any non-literal arg — invisible by design.
    if (onUnresolved) onUnresolved(arg, matchingNamespaces);
}
