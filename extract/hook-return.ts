import ts from 'typescript';

import {resolveStringLiterals} from '../extract-resolver.js';
import {collectHookAliases} from './aliases.js';
import {callToNamespaces} from './hook-calls.js';

export function applyHookReturnBindings(args: {
    decl: ts.VariableDeclaration;
    checker: ts.TypeChecker;
    hookName: string;
    hookPackage: string | undefined;
    cache: Map<ts.Symbol, Map<string, Set<string>>>;
    addBinding: (varName: string, nameNode: ts.BindingName, namespaces: string[]) => void;
}): void {
    const {decl, checker, hookName, hookPackage, cache, addBinding} = args;
    if (!decl.initializer || !ts.isCallExpression(decl.initializer)) return;
    if (!ts.isObjectBindingPattern(decl.name)) return;

    const callee = decl.initializer.expression;
    const calleeIdent = ts.isIdentifier(callee) ? callee : null;
    if (!calleeIdent) return;

    const fnSymbol = checker.getSymbolAtLocation(calleeIdent);
    if (!fnSymbol) return;
    const resolvedSymbol = (fnSymbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(fnSymbol)
        : fnSymbol;

    const returns = resolveHookReturnNamespaces(resolvedSymbol, checker, hookName, hookPackage, cache);
    if (!returns || returns.size === 0) return;

    for (const element of decl.name.elements) {
        if (!ts.isBindingElement(element)) continue;
        const propName = element.propertyName
            ? (ts.isIdentifier(element.propertyName) ? element.propertyName.text : null)
            : (ts.isIdentifier(element.name) ? element.name.text : null);
        if (!propName) continue;
        const nss = returns.get(propName);
        if (!nss || nss.size === 0) continue;
        const localName = ts.isIdentifier(element.name) ? element.name.text : null;
        if (!localName) continue;
        addBinding(localName, element.name, [...nss]);
    }
}

export function resolveHookReturnNamespaces(
    fnSymbol: ts.Symbol,
    checker: ts.TypeChecker,
    hookName: string,
    hookPackage: string | undefined,
    cache: Map<ts.Symbol, Map<string, Set<string>>>,
): Map<string, Set<string>> | null {
    const cached = cache.get(fnSymbol);
    if (cached) return cached;

    const result = new Map<string, Set<string>>();
    // Seed empty to prevent infinite recursion when two hooks import each other.
    cache.set(fnSymbol, result);

    const decls = fnSymbol.declarations ?? [];
    for (const decl of decls) {
        const fnNode = asFunctionLike(decl);
        if (!fnNode) continue;
        collectReturnNamespacesFrom(fnNode, result, checker, hookName, hookPackage, cache);
    }

    if (result.size === 0) return null;
    return result;
}

export function asFunctionLike(node: ts.Node): ts.SignatureDeclaration | null {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
        return node;
    }
    // `const useFoo = () => {...}` — symbol's decl is the VariableDeclaration;
    // step into the initializer.
    if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
            return node.initializer;
        }
    }
    return null;
}

export function collectReturnNamespacesFrom(
    fn: ts.SignatureDeclaration,
    out: Map<string, Set<string>>,
    checker: ts.TypeChecker,
    hookName: string,
    hookPackage: string | undefined,
    cache: Map<ts.Symbol, Map<string, Set<string>>>,
): void {
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (!body) return;

    const hookAliases = collectHookAliases(fn.getSourceFile(), hookName, hookPackage);

    const localVars = new Map<string, Set<string>>();

    const visitLocal = (n: ts.Node): void => {
        // Don't cross function boundaries — only this hook's own bindings count.
        if (n !== fn && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n))) {
            return;
        }
        if (ts.isVariableDeclaration(n) && n.initializer) {
            const nss = callToNamespaces(n.initializer, hookAliases, checker);
            if (nss !== null && ts.isIdentifier(n.name)) {
                localVars.set(n.name.text, new Set(nss));
            }
            // Nested hook-return: `const {t} = useOtherHook()` inside this hook.
            if (ts.isObjectBindingPattern(n.name) && ts.isCallExpression(n.initializer)) {
                const inner = n.initializer.expression;
                if (ts.isIdentifier(inner)) {
                    const innerSym = checker.getSymbolAtLocation(inner);
                    if (innerSym) {
                        const resolved = (innerSym.flags & ts.SymbolFlags.Alias) !== 0
                            ? checker.getAliasedSymbol(innerSym)
                            : innerSym;
                        const innerReturns = resolveHookReturnNamespaces(resolved, checker, hookName, hookPackage, cache);
                        if (innerReturns) {
                            for (const element of n.name.elements) {
                                if (!ts.isBindingElement(element)) continue;
                                const propName = element.propertyName
                                    ? (ts.isIdentifier(element.propertyName) ? element.propertyName.text : null)
                                    : (ts.isIdentifier(element.name) ? element.name.text : null);
                                const localName = ts.isIdentifier(element.name) ? element.name.text : null;
                                if (propName && localName) {
                                    const innerNss = innerReturns.get(propName);
                                    if (innerNss) localVars.set(localName, new Set(innerNss));
                                }
                            }
                        }
                    }
                }
            }
        }
        ts.forEachChild(n, visitLocal);
    };
    visitLocal(body);

    const visitReturns = (n: ts.Node): void => {
        if (n !== fn && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n))) {
            return;
        }
        if (ts.isReturnStatement(n) && n.expression) {
            collectFromReturnExpression(n.expression, out, localVars);
        }
        ts.forEachChild(n, visitReturns);
    };
    visitReturns(body);

    // Arrow with implicit-return object literal: `() => ({ t, tCommon })`.
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
        collectFromReturnExpression(fn.body, out, localVars);
    }
}

export function collectFromReturnExpression(
    expr: ts.Expression,
    out: Map<string, Set<string>>,
    localVars: Map<string, Set<string>>,
): void {
    const obj = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
    if (!ts.isObjectLiteralExpression(obj)) return;
    for (const prop of obj.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
            const name = prop.name.text;
            const nss = localVars.get(name);
            if (nss) mergeInto(out, name, nss);
        } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            const outKey = prop.name.text;
            const init = prop.initializer;
            if (ts.isIdentifier(init)) {
                const nss = localVars.get(init.text);
                if (nss) mergeInto(out, outKey, nss);
            }
        }
    }
}

export function mergeInto(
    out: Map<string, Set<string>>,
    key: string,
    values: Set<string>,
): void {
    if (!out.has(key)) out.set(key, new Set());
    const bucket = out.get(key)!;
    for (const v of values) bucket.add(v);
}

export function absorbNamespaces(
    expr: ts.Expression,
    checker: ts.TypeChecker,
    hookAliases: Set<string>,
    out: Set<string>,
): void {
    // Cross-file: a caller's file may use a different alias for useTranslations.
    // Recognize the hook by imported-symbol name too, not just current aliases.
    const isHookCall = (call: ts.CallExpression): boolean => {
        const calleeExpr = call.expression;
        if (!ts.isIdentifier(calleeExpr)) return false;
        if (hookAliases.has(calleeExpr.text)) return true;
        const sym = checker.getSymbolAtLocation(calleeExpr);
        if (!sym) return false;
        const resolved = (sym.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(sym) : sym;
        return resolved.name === 'useTranslations';
    };

    if (ts.isCallExpression(expr) && isHookCall(expr) && expr.arguments.length > 0) {
        const arg = expr.arguments[0];
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
            out.add(arg.text);
            return;
        }
        const resolved = resolveStringLiterals(arg, checker);
        if (resolved) for (const v of resolved) out.add(v);
        return;
    }
    // Special case: when the identifier is the name of a shorthand property
    // assignment (`{ tSchedule }`), TypeScript returns the shorthand's own
    // symbol — we need `getShorthandAssignmentValueSymbol` to reach the outer
    // `const tSchedule = useTranslations('schedule')` binding.
    if (ts.isIdentifier(expr)) {
        const parent = expr.parent;
        const sym =
            parent && ts.isShorthandPropertyAssignment(parent) && parent.name === expr
                ? (checker.getShorthandAssignmentValueSymbol(parent) ?? checker.getSymbolAtLocation(expr))
                : checker.getSymbolAtLocation(expr);
        if (!sym) return;
        for (const decl of sym.declarations ?? []) {
            if (ts.isVariableDeclaration(decl) && decl.initializer) {
                absorbNamespaces(decl.initializer, checker, hookAliases, out);
            }
        }
    }
}
