import ts from 'typescript';

import {absorbNamespaces} from './hook-return.js';

interface TParamInfo {
    paramName: string;
    paramSymbol: ts.Symbol | null;
    containerSymbol: ts.Symbol;
    /** 0-based position of the parameter in the function signature. */
    paramIndex: number;
    /**
     * Key within the destructured object parameter at `paramIndex` (e.g. `t`).
     * `null` for positional function parameters like `function f(x, t, y)`.
     */
    destructureKey: string | null;
}

export function resolvePropFlowBindings(args: {
    sourceFile: ts.SourceFile;
    programSourceFiles: ts.SourceFile[];
    checker: ts.TypeChecker;
    hookAliases: Set<string>;
    recordBinding: (symbol: ts.Symbol | null, varName: string, namespaces: string[]) => void;
    recordUnresolvedCaller: (callerSf: ts.SourceFile, node: ts.Node) => void;
}): void {
    const {sourceFile, programSourceFiles, checker, hookAliases, recordBinding, recordUnresolvedCaller} = args;

    const visit = (node: ts.Node): void => {
        for (const paramInfo of extractTParamInfos(node, checker)) {
            const namespaces = resolveNamespacesFromCallers(paramInfo, programSourceFiles, checker, hookAliases, recordUnresolvedCaller);
            if (namespaces.length > 0) {
                recordBinding(paramInfo.paramSymbol, paramInfo.paramName, namespaces);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
}

/**
 * Detect parameters carrying a translation function, by shape: parameter's
 * declared name looks like a translator (`t`, `tFeature`, ...) AND its type is
 * either a function returning string-like, or `ReturnType<typeof useTranslations<...>>`.
 */
function extractTParamInfos(node: ts.Node, checker: ts.TypeChecker): TParamInfo[] {
    if (!isFunctionLike(node)) return [];
    const fn = node as ts.SignatureDeclaration;
    const containerSymbol = containerSymbolFor(fn, checker);
    if (!containerSymbol) return [];

    const out: TParamInfo[] = [];

    for (let paramIndex = 0; paramIndex < fn.parameters.length; paramIndex++) {
        const param = fn.parameters[paramIndex];

        // Destructured object with a translator-looking property:
        //   function Foo({t}: {t: (key: string) => string}) { ... }
        if (ts.isObjectBindingPattern(param.name) && param.type && ts.isTypeLiteralNode(param.type)) {
            for (const element of param.name.elements) {
                if (!ts.isBindingElement(element)) continue;
                const propKey = element.propertyName
                    ? (ts.isIdentifier(element.propertyName) ? element.propertyName.text : null)
                    : (ts.isIdentifier(element.name) ? element.name.text : null);
                if (!propKey || !isTranslationFunctionName(propKey)) continue;

                const localName = ts.isIdentifier(element.name) ? element.name.text : null;
                if (!localName) continue;

                const member = param.type.members.find(
                    m => m.name && ts.isIdentifier(m.name) && m.name.text === propKey,
                );
                if (!member || !ts.isPropertySignature(member)) continue;
                if (!member.type || !isTranslationFunctionType(member.type)) continue;

                const paramIdent = ts.isIdentifier(element.name) ? element.name : null;
                const paramSymbol = paramIdent ? (checker.getSymbolAtLocation(paramIdent) ?? null) : null;

                out.push({
                    paramName: localName,
                    paramSymbol,
                    containerSymbol,
                    paramIndex,
                    destructureKey: propKey,
                });
            }
            continue;
        }

        // Positional identifier param typed as a translation function:
        //   function helper(date: string, t: (k: string) => string) { ... }
        if (ts.isIdentifier(param.name) && isTranslationFunctionName(param.name.text) && param.type) {
            if (!isTranslationFunctionType(param.type)) continue;
            const paramSymbol = checker.getSymbolAtLocation(param.name) ?? null;
            out.push({
                paramName: param.name.text,
                paramSymbol,
                containerSymbol,
                paramIndex,
                destructureKey: null,
            });
        }
    }

    return out;
}

/**
 * Recognise types lexen considers "a translation function":
 *   - `(key: string) => string | ReactNode | ...`
 *   - `ReturnType<typeof useTranslations<...>>`
 */
function isTranslationFunctionType(type: ts.TypeNode): boolean {
    if (ts.isFunctionTypeNode(type)) return returnsStringLike(type);
    if (ts.isTypeReferenceNode(type)) {
        const name = ts.isIdentifier(type.typeName) ? type.typeName.text : null;
        if (name === 'ReturnType' && type.typeArguments && type.typeArguments.length === 1) {
            const inner = type.typeArguments[0];
            if (ts.isTypeQueryNode(inner)) {
                const q = inner.exprName;
                const leaf = ts.isIdentifier(q) ? q.text : ts.isQualifiedName(q) ? q.right.text : null;
                if (leaf && /^use[A-Z]/.test(leaf)) return true;
            }
        }
    }
    return false;
}

function isTranslationFunctionName(name: string): boolean {
    return name === 't' || /^t[A-Z]/.test(name);
}

function isFunctionLike(node: ts.Node): boolean {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
    );
}

function returnsStringLike(type: ts.FunctionTypeNode): boolean {
    const ret = type.type;
    if (!ret) return false;
    if (ret.kind === ts.SyntaxKind.StringKeyword) return true;
    if (ts.isTypeReferenceNode(ret)) {
        const name = ts.isIdentifier(ret.typeName) ? ret.typeName.text : null;
        // Allow ReactNode/ReactElement — next-intl's `t.rich` returns these.
        if (name && /^(React(Node|Element)|string|JSX\.Element)$/.test(name)) return true;
    }
    return false;
}

function containerSymbolFor(fn: ts.SignatureDeclaration, checker: ts.TypeChecker): ts.Symbol | null {
    if (ts.isFunctionDeclaration(fn) && fn.name) {
        return checker.getSymbolAtLocation(fn.name) ?? null;
    }
    // Arrow/expression assigned to a variable: `const Foo = ({t}) => ...`.
    const parent = fn.parent;
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return checker.getSymbolAtLocation(parent.name) ?? null;
    }
    return null;
}

function resolveNamespacesFromCallers(
    info: TParamInfo,
    programSourceFiles: ts.SourceFile[],
    checker: ts.TypeChecker,
    hookAliases: Set<string>,
    onUnresolvedCaller: (callerSf: ts.SourceFile, node: ts.Node) => void,
): string[] {
    const symbol = checker.getSymbolAtLocation((info.containerSymbol.declarations?.[0] as ts.NamedDeclaration | undefined)?.name as ts.Node | undefined ?? undefined as unknown as ts.Node) ?? info.containerSymbol;
    const found = new Set<string>();

    // Walk every program source file — cross-file callers are the normal case.
    for (const sf of programSourceFiles) {
        collectCallerArgs(sf, symbol, info, checker, hookAliases, found, onUnresolvedCaller);
    }
    return [...found];
}

function collectCallerArgs(
    sf: ts.SourceFile,
    targetSymbol: ts.Symbol,
    info: TParamInfo,
    checker: ts.TypeChecker,
    hookAliases: Set<string>,
    found: Set<string>,
    onUnresolvedCaller: (callerSf: ts.SourceFile, node: ts.Node) => void,
): void {
    // Use a fresh per-call set: a `found.size` snapshot wouldn't work because
    // the set dedupes across callers. A zero-result absorb on a reference-like
    // expression means RULES rule 4 violation. Skip reporting for inline
    // function args — the real `t()` call lives in the arrow body and lexen
    // scans it on its own pass; the builder's own `t` param is called with
    // intermediate values only, not literal keys.
    const absorbWithReport = (expr: ts.Expression): void => {
        const local = new Set<string>();
        absorbNamespaces(expr, checker, hookAliases, local);
        const isInlineFunction = ts.isArrowFunction(expr) || ts.isFunctionExpression(expr);
        if (local.size === 0 && !isInlineFunction) {
            onUnresolvedCaller(sf, expr);
        } else {
            for (const ns of local) found.add(ns);
        }
    };

    const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningLikeElement(node)) {
            const tagSymbol = getJsxTagSymbol(node, checker);
            if (tagSymbol === targetSymbol || sameSymbolTarget(tagSymbol, targetSymbol, checker)) {
                const attr = findJsxAttr(node, info.destructureKey ?? '');
                if (attr) {
                    const expr = getAttrExpression(attr);
                    if (expr) absorbWithReport(expr);
                }
            }
        }
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const calleeSymbol = ts.isIdentifier(callee)
                ? checker.getSymbolAtLocation(callee)
                : null;
            if (calleeSymbol && sameSymbolTarget(calleeSymbol, targetSymbol, checker)) {
                if (info.destructureKey !== null) {
                    const arg = node.arguments[info.paramIndex];
                    if (arg && ts.isObjectLiteralExpression(arg)) {
                        const prop = arg.properties.find(
                            p => p.name && ts.isIdentifier(p.name) && p.name.text === info.destructureKey,
                        );
                        if (prop && ts.isPropertyAssignment(prop)) {
                            absorbWithReport(prop.initializer);
                        } else if (prop && ts.isShorthandPropertyAssignment(prop)) {
                            absorbWithReport(prop.name);
                        }
                    }
                } else {
                    const arg = node.arguments[info.paramIndex];
                    if (arg) absorbWithReport(arg);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
}

function getJsxTagSymbol(node: ts.JsxOpeningLikeElement, checker: ts.TypeChecker): ts.Symbol | null {
    const tag = node.tagName;
    if (ts.isIdentifier(tag)) return checker.getSymbolAtLocation(tag) ?? null;
    return null;
}

function sameSymbolTarget(
    a: ts.Symbol | null | undefined,
    b: ts.Symbol | null | undefined,
    checker: ts.TypeChecker,
): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    // Follow import alias chains so an imported binding matches its source decl.
    const ra = (a.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(a) : a;
    const rb = (b.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(b) : b;
    return ra === rb;
}

function findJsxAttr(
    node: ts.JsxOpeningLikeElement,
    name: string,
): ts.JsxAttribute | null {
    for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === name) {
            return attr;
        }
    }
    return null;
}

function getAttrExpression(attr: ts.JsxAttribute): ts.Expression | null {
    const init = attr.initializer;
    if (!init) return null;
    if (ts.isJsxExpression(init) && init.expression) return init.expression;
    return null;
}
