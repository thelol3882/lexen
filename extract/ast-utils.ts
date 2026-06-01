import ts from 'typescript';

import type {NamespaceKeys} from '../types.js';

export function getCallReceiverName(callNode: ts.CallExpression): string | null {
    const expr = callNode.expression;
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
        return expr.expression.text;
    }
    return null;
}

export function callReceiverInfo(callNode: ts.CallExpression): {varName: string; varIdent: ts.Identifier | null; method: string | null} | null {
    const expr = callNode.expression;
    if (ts.isIdentifier(expr)) {
        return {varName: expr.text, varIdent: expr, method: null};
    }
    if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        ts.isIdentifier(expr.name)
    ) {
        return {varName: expr.expression.text, varIdent: expr.expression, method: expr.name.text};
    }
    return null;
}

export function isValidKey(key: string): boolean {
    return /^[\w]+(\.[\w]+)*$/.test(key);
}

export function templatePrefix(head: string): string | null {
    const m = head.match(/^([\w]+(?:\.[\w]+)*)\.$/);
    return m ? m[1] : null;
}

export function addKeyToNamespaces(key: string, namespaces: string[], namespaceKeys: NamespaceKeys): void {
    if (!isValidKey(key)) return;
    for (const ns of namespaces) {
        if (!namespaceKeys.has(ns)) namespaceKeys.set(ns, new Set());
        namespaceKeys.get(ns)!.add(key);
    }
}

export function* bindingNames(name: ts.BindingName): Generator<string> {
    if (ts.isIdentifier(name)) {
        yield name.text;
        return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const element of name.elements) {
            if (ts.isBindingElement(element)) {
                yield* bindingNames(element.name);
            }
        }
    }
}

export function* identifiersInBinding(name: ts.BindingName): Generator<ts.Identifier> {
    if (ts.isIdentifier(name)) {
        yield name;
        return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const element of name.elements) {
            if (ts.isBindingElement(element)) {
                yield* identifiersInBinding(element.name);
            }
        }
    }
}
