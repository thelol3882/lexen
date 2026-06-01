import ts from 'typescript';

import {resolveStringLiterals} from '../extract-resolver.js';
import type {CallExtractorConfig, NamespaceKeys, UnresolvedCall, UsageRecord} from '../types.js';
import {addKeyToNamespaces, getCallReceiverName} from './ast-utils.js';

/**
 * Parse a key template like `"metadata.${key}.title"` into alternating literal
 * segments and hole prop-names. Returns an array of tokens where even indices
 * are literal strings and odd indices are prop names.
 *
 *   parseKeyTemplate('metadata.${key}.title')
 *   → ['metadata.', 'key', '.title']
 */
function parseKeyTemplate(template: string): string[] {
    const tokens: string[] = [];
    const re = /\$\{(\w+)}/g;
    let last = 0;
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(template)) !== null) {
        tokens.push(template.slice(last, match.index)); // literal before hole
        tokens.push(match[1]); // hole prop name
        last = match.index + match[0].length;
    }
    tokens.push(template.slice(last)); // trailing literal
    return tokens;
}

/**
 * Find a property (assignment or shorthand) with the given name in an object literal.
 * Returns the initializer expression for use with `resolvePropertyValue`.
 */
function findPropertyValue(
    obj: ts.ObjectLiteralExpression,
    name: string,
): ts.Expression | null {
    for (const prop of obj.properties) {
        if (!prop.name || !ts.isIdentifier(prop.name) || prop.name.text !== name) continue;
        if (ts.isPropertyAssignment(prop)) {
            return prop.initializer;
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
            // Shorthand `{key}` — the name itself is the expression.
            return prop.name;
        }
    }
    return null;
}

/** Resolve a property initializer expression to string literals. */
function resolvePropertyValue(
    expr: ts.Expression,
    checker: ts.TypeChecker | null,
): string[] | null {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        return [expr.text];
    }
    if (checker) {
        return resolveStringLiterals(expr, checker);
    }
    return null;
}

/**
 * Walk call expressions in `sourceFile` looking for calls whose callee is in
 * `aliases` and whose arg at `callCfg.arg` is an object literal. Resolve the
 * namespace and key-template holes via `resolveStringLiterals`, cartesian-expand
 * across all holes, and feed the results to `addKeyToNamespaces`.
 */
export function collectConfiguredCalls(
    sourceFile: ts.SourceFile,
    callCfg: CallExtractorConfig,
    aliases: Set<string>,
    featureFilter: string | null,
    namespaceKeys: NamespaceKeys,
    namespaceUsages: UsageRecord[],
    unresolvedCalls: UnresolvedCall[],
    checker: ts.TypeChecker | null,
    relFile: string,
    recordUnresolved: (call: 'call', arg: ts.Node) => void,
): void {
    const argIndex = callCfg.arg ?? 0;

    const recordUsageLocal = (namespaces: string[], node: ts.Node): void => {
        const {line, character} = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
        for (const ns of namespaces) {
            namespaceUsages.push({namespace: ns, file: relFile, line: line + 1, column: character + 1});
        }
    };

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const name = getCallReceiverName(node);
            if (name && aliases.has(name)) {
                processConfiguredCall(node);
            }
        }
        ts.forEachChild(node, visit);
    };

    const processConfiguredCall = (node: ts.CallExpression): void => {
        // Resolve the object-literal argument.
        const rawArg = node.arguments[argIndex];
        const objLit = rawArg && ts.isObjectLiteralExpression(rawArg) ? rawArg : null;

        // --- Resolve namespace ---
        let resolvedNamespaces: string[];

        if (objLit) {
            const nsExpr = findPropertyValue(objLit, callCfg.namespace.prop);
            if (nsExpr) {
                // Try to resolve the property value.
                const nsValues = resolvePropertyValue(nsExpr, checker);
                if (nsValues !== null && nsValues.length > 0) {
                    resolvedNamespaces = nsValues;
                } else {
                    // Can't resolve — record unresolved and bail.
                    recordUnresolved('call', nsExpr);
                    return;
                }
            } else if (callCfg.namespace.default !== undefined) {
                // Property absent, use default.
                resolvedNamespaces = [callCfg.namespace.default];
            } else {
                // No property, no default — unresolved.
                recordUnresolved('call', rawArg ?? node);
                return;
            }
        } else if (callCfg.namespace.default !== undefined) {
            // No object arg at all — use namespace default (e.g. buildRootMetadata()).
            resolvedNamespaces = [callCfg.namespace.default];
        } else {
            // No arg and no default.
            recordUnresolved('call', node);
            return;
        }

        // Apply featureFilter — same semantics as collectTranslationCall.
        const matchingNamespaces = resolvedNamespaces.filter(
            ns => !featureFilter || ns === featureFilter || ns === 'common',
        );
        if (matchingNamespaces.length === 0) return;

        // Push namespace usages so validate can catch invalid namespaces.
        recordUsageLocal(matchingNamespaces, node);

        // --- Resolve each key template ---
        for (const keyTemplate of callCfg.keys) {
            const tokens = parseKeyTemplate(keyTemplate);
            // Collect hole values: tokens at odd positions are prop names.
            // tokens = [lit0, prop0, lit1, prop1, lit2, ...]
            // We build a list of arrays: [[lit0], [values for prop0], [lit1], ...]
            const parts: string[][] = [];
            let allResolved = true;
            let unresolvableNode: ts.Node = node;

            for (let ti = 0; ti < tokens.length; ti++) {
                if (ti % 2 === 0) {
                    // Literal segment.
                    parts.push([tokens[ti]]);
                } else {
                    // Hole: resolve from object arg property or defaults.
                    const propName = tokens[ti];
                    let holeValues: string[] | null = null;

                    if (objLit) {
                        const holeExpr = findPropertyValue(objLit, propName);
                        if (holeExpr) {
                            holeValues = resolvePropertyValue(holeExpr, checker);
                            if (holeValues === null) {
                                // Resolver returned null (widened to string) — unresolved.
                                unresolvableNode = holeExpr;
                                allResolved = false;
                                break;
                            }
                        }
                    }

                    if (holeValues === null) {
                        // Property absent — try defaults.
                        const def = callCfg.defaults?.[propName];
                        if (def !== undefined) {
                            holeValues = [def];
                        } else {
                            // No property and no default — unresolved.
                            unresolvableNode = rawArg ?? node;
                            allResolved = false;
                            break;
                        }
                    }

                    parts.push(holeValues);
                }
            }

            if (!allResolved) {
                recordUnresolved('call', unresolvableNode);
                continue;
            }

            // Cartesian product across all parts.
            let combined: string[] = [''];
            for (const options of parts) {
                const next: string[] = [];
                for (const base of combined) {
                    for (const opt of options) next.push(base + opt);
                }
                combined = next;
            }

            for (const key of combined) {
                addKeyToNamespaces(key, matchingNamespaces, namespaceKeys);
            }
        }
    };

    visit(sourceFile);
}
