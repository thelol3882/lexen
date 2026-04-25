import fs from 'fs';
import path from 'path';

import {glob} from 'glob';
import ts from 'typescript';

import {buildProgram, resolveStringLiterals} from './extract-resolver.js';
import type {
    AutoPreserved,
    Config,
    ExtractOptions,
    ExtractResult,
    NamespaceKeys,
    ResolverMode,
    UnresolvedCall,
    UsageRecord,
} from './types.js';

/**
 * Sentinel for a bare `useTranslations()` call (no namespace argument). Bare
 * bindings violate RULES.md rule 5; recorded against this sentinel so
 * `validate.findInvalidNamespaceUsages` can surface the call site. Keys are
 * not extracted because without an explicit namespace we'd have to guess.
 */
export const BARE_NAMESPACE = '<<bare>>';

export function extractAll(config: Config, options: ExtractOptions = {}): ExtractResult {
    const {featureFilter = null, resolverOverride} = options;
    const mode: ResolverMode = resolverOverride ?? config.resolverResolved.mode;

    const namespaceKeys: NamespaceKeys = new Map();
    const autoPreserved: AutoPreserved = new Map();
    const namespaceUsages: UsageRecord[] = [];
    const unresolvedCalls: UnresolvedCall[] = [];

    let checker: ts.TypeChecker | null = null;
    const sourceFiles: {relFile: string; sourceFile: ts.SourceFile}[] = [];

    const relevantFiles = new Set<string>(
        glob.sync(config.filePatterns, {
            cwd: config.absSrcDir,
            ignore: config.ignore ?? [],
            windowsPathsNoEscape: true,
        }).map(rel => rel.split(path.sep).join('/')),
    );

    if (mode === 'typechecker') {
        const built = buildProgram(config);
        checker = built.checker;
        for (const sf of built.program.getSourceFiles()) {
            if (sf.isDeclarationFile) continue;
            const abs = path.normalize(sf.fileName);
            if (!abs.startsWith(path.normalize(config.absSrcDir))) continue;
            const relRaw = path.relative(config.absSrcDir, abs);
            const rel = relRaw.split(path.sep).join('/');
            if (!relevantFiles.has(rel)) continue;
            sourceFiles.push({relFile: rel, sourceFile: sf});
        }
    } else {
        for (const relFile of relevantFiles) {
            const absFile = path.join(config.absSrcDir, relFile);
            const source = fs.readFileSync(absFile, 'utf8');
            const sourceFile = ts.createSourceFile(
                absFile,
                source,
                ts.ScriptTarget.Latest,
                /* setParentNodes */ true,
                relFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
            );
            sourceFiles.push({relFile: relFile.split(path.sep).join('/'), sourceFile});
        }
    }

    // Keyed by hook function symbol so repeat consumers share the same analysis.
    const hookReturnCache = new Map<ts.Symbol, Map<string, Set<string>>>();

    // For prop-flow caller lookup across the whole program, not just the
    // declaration's own file.
    const programSourceFiles = sourceFiles.map(s => s.sourceFile);

    for (const {relFile, sourceFile} of sourceFiles) {
        extractFromSourceFile({
            config,
            sourceFile,
            relFile,
            featureFilter,
            namespaceKeys,
            autoPreserved,
            namespaceUsages,
            unresolvedCalls,
            checker,
            propFlow: mode === 'typechecker' && config.resolverResolved.propFlow,
            hookReturnFlow: mode === 'typechecker',
            hookReturnCache,
            programSourceFiles,
        });
    }

    return {namespaceKeys, autoPreserved, namespaceUsages, unresolvedCalls};
}

interface ExtractCtx {
    config: Config;
    sourceFile: ts.SourceFile;
    relFile: string;
    featureFilter: string | null;
    namespaceKeys: NamespaceKeys;
    autoPreserved: AutoPreserved;
    namespaceUsages: UsageRecord[];
    unresolvedCalls: UnresolvedCall[];
    checker: ts.TypeChecker | null;
    propFlow: boolean;
    /** Track `const {t} = someHook()` patterns by walking someHook's body. */
    hookReturnFlow: boolean;
    hookReturnCache: Map<ts.Symbol, Map<string, Set<string>>>;
    /** All program source files — for cross-file prop-flow caller lookup. */
    programSourceFiles: ts.SourceFile[];
}

function extractFromSourceFile(ctx: ExtractCtx): void {
    const {config, sourceFile, relFile, featureFilter, namespaceKeys, autoPreserved, namespaceUsages, unresolvedCalls, checker, propFlow, hookReturnFlow, hookReturnCache, programSourceFiles} = ctx;

    const recordUnresolved = (call: 'useTranslations' | 't', arg: ts.Node): void => {
        const {line, character} = ts.getLineAndCharacterOfPosition(sourceFile, arg.getStart(sourceFile));
        const raw = arg.getText(sourceFile);
        const snippet = raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
        unresolvedCalls.push({
            call,
            namespace: '<unresolved>',
            file: relFile,
            line: line + 1,
            column: character + 1,
            snippet,
        });
    };
    const hookName = config.hook.name;
    const hookPackage = config.hook.package;

    const hookAliases = collectHookAliases(sourceFile, hookName, hookPackage);
    // Files with no direct hook import may still destructure translators from a
    // custom hook (e.g. `const {t} = useGroupPlayersTable()`). In typechecker
    // mode keep walking so the hook-return resolver can pick those up.
    if (hookAliases.size === 0 && !propFlow && !hookReturnFlow) return;

    // First pass collects variable bindings; second pass collects `t('key')`
    // calls. Two passes because a file may call `t(...)` before its
    // `useTranslations(...)` binding in source order.
    const varToNamespaces = new Map<string, Set<string>>();

    // Symbol-keyed map: separate declarations of the same name (e.g. two
    // `const t` in sibling scopes) must NOT union, since each `t(...)` call
    // lexically belongs to one scope. In AST-only mode (no checker) we fall
    // back to name-based with last-writer-wins.
    const symToNamespaces = new Map<ts.Symbol, Set<string>>();
    const addBinding = (varName: string, nameNode: ts.BindingName, namespaces: string[]): void => {
        varToNamespaces.set(varName, new Set(namespaces));
        if (checker) {
            for (const ident of identifiersInBinding(nameNode)) {
                const sym = checker.getSymbolAtLocation(ident);
                if (sym) symToNamespaces.set(sym, new Set(namespaces));
            }
        }
    };

    const recordUsage = (namespaces: string[], node: ts.Node): void => {
        const {line, character} = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
        for (const ns of namespaces) {
            namespaceUsages.push({namespace: ns, file: relFile, line: line + 1, column: character + 1});
        }
    };

    const collectBindings = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer) {
            const namespaces = callToNamespaces(node.initializer, hookAliases, checker, (arg) => recordUnresolved('useTranslations', arg));
            if (namespaces !== null) {
                recordUsage(namespaces, node.initializer);
                for (const varName of bindingNames(node.name)) {
                    addBinding(varName, node.name, namespaces);
                }
            }

            // Hook-return flow: `const { t, tCommon } = useGroupPlayersTable(...)`.
            if (hookReturnFlow && checker && ts.isObjectBindingPattern(node.name) && ts.isCallExpression(node.initializer)) {
                applyHookReturnBindings({
                    decl: node,
                    checker,
                    hookName,
                    hookPackage,
                    cache: hookReturnCache,
                    addBinding,
                });
            }
        }

        // Bare hook calls not assigned to anything — report as usages for
        // namespace validation; no variable to track.
        if (ts.isCallExpression(node)) {
            const calleeText = getCallReceiverName(node);
            if (calleeText && hookAliases.has(calleeText)) {
                const parent = node.parent;
                const isAssigned = parent && ts.isVariableDeclaration(parent) && parent.initializer === node;
                if (!isAssigned) {
                    const namespaces = callToNamespaces(node, hookAliases, checker, (arg) => recordUnresolved('useTranslations', arg));
                    if (namespaces !== null) recordUsage(namespaces, node);
                }
            }
        }

        ts.forEachChild(node, collectBindings);
    };
    collectBindings(sourceFile);

    // Propagate `t` passed as a prop: if the file defines a component with a
    // `t` parameter typed as a translation function, and a caller passes
    // `useTranslations('ns')` (or a bound alias) as that prop, treat the inner
    // param as if it were bound to 'ns'.
    if (propFlow && checker) {
        resolvePropFlowBindings({
            sourceFile,
            programSourceFiles,
            checker,
            hookAliases,
            recordBinding: (symbol, varName, namespaces) => {
                varToNamespaces.set(varName, new Set(namespaces));
                if (symbol) symToNamespaces.set(symbol, new Set(namespaces));
            },
            recordUnresolvedCaller: (callerSf, node) => {
                // Surface so user can fix the RULES rule 4 violation (caller
                // passed a `t` expression untraceable to `useTranslations`).
                const abs = path.normalize(callerSf.fileName);
                const relRaw = path.relative(config.absSrcDir, abs);
                const callerRelFile = relRaw.split(path.sep).join('/');
                const {line, character} = ts.getLineAndCharacterOfPosition(callerSf, node.getStart(callerSf));
                const raw = node.getText(callerSf);
                const snippet = raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
                unresolvedCalls.push({
                    call: 'propFlow',
                    namespace: '<unresolved>',
                    file: callerRelFile,
                    line: line + 1,
                    column: character + 1,
                    snippet,
                });
            },
        });
    }

    if (varToNamespaces.size === 0 && symToNamespaces.size === 0) return;

    const collectKeys = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            collectTranslationCall(
                node,
                varToNamespaces,
                symToNamespaces,
                featureFilter,
                namespaceKeys,
                autoPreserved,
                checker,
                (arg) => recordUnresolved('t', arg),
            );
        }
        ts.forEachChild(node, collectKeys);
    };
    collectKeys(sourceFile);
}

function collectHookAliases(
    sourceFile: ts.SourceFile,
    hookName: string,
    hookPackage: string | undefined,
): Set<string> {
    const aliases = new Set<string>();

    for (const stmt of sourceFile.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;
        if (!stmt.importClause) continue;

        const moduleSpec = stmt.moduleSpecifier;
        if (hookPackage && ts.isStringLiteral(moduleSpec) && moduleSpec.text !== hookPackage) {
            continue;
        }

        const named = stmt.importClause.namedBindings;
        if (named && ts.isNamedImports(named)) {
            for (const element of named.elements) {
                const original = element.propertyName ? element.propertyName.text : element.name.text;
                if (original === hookName) {
                    aliases.add(element.name.text);
                }
            }
        }
    }

    return aliases;
}

function callToNamespaces(
    node: ts.Node,
    hookAliases: Set<string>,
    checker: ts.TypeChecker | null,
    onUnresolved?: (arg: ts.Node) => void,
): string[] | null {
    if (!ts.isCallExpression(node)) return null;
    const name = getCallReceiverName(node);
    if (!name || !hookAliases.has(name)) return null;

    if (node.arguments.length >= 1) {
        const arg = node.arguments[0];
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

function getCallReceiverName(callNode: ts.CallExpression): string | null {
    const expr = callNode.expression;
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
        return expr.expression.text;
    }
    return null;
}

function* bindingNames(name: ts.BindingName): Generator<string> {
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

function* identifiersInBinding(name: ts.BindingName): Generator<ts.Identifier> {
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

function collectTranslationCall(
    node: ts.CallExpression,
    varToNamespaces: Map<string, Set<string>>,
    symToNamespaces: Map<ts.Symbol, Set<string>>,
    featureFilter: string | null,
    namespaceKeys: NamespaceKeys,
    autoPreserved: AutoPreserved,
    checker: ts.TypeChecker | null,
    onUnresolved?: (arg: ts.Node) => void,
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
            }
            return;
        }
    }
    // Non-literal arg the resolver couldn't see through (RULES.md rule 6).
    // AST-mode also lands here for any non-literal arg — invisible by design.
    if (onUnresolved) onUnresolved(arg);
}

function addKeyToNamespaces(key: string, namespaces: string[], namespaceKeys: NamespaceKeys): void {
    if (!isValidKey(key)) return;
    for (const ns of namespaces) {
        if (!namespaceKeys.has(ns)) namespaceKeys.set(ns, new Set());
        namespaceKeys.get(ns)!.add(key);
    }
}

function callReceiverInfo(callNode: ts.CallExpression): {varName: string; varIdent: ts.Identifier | null; method: string | null} | null {
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

function isValidKey(key: string): boolean {
    return /^[\w]+(\.[\w]+)*$/.test(key);
}

function templatePrefix(head: string): string | null {
    const m = head.match(/^([\w]+(?:\.[\w]+)*)\.$/);
    return m ? m[1] : null;
}

function resolvePropFlowBindings(args: {
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

/**
 * Hook-return flow: walk a custom hook's body once, map returned property
 * names to the namespaces of `useTranslations` calls inside it. Only
 * top-level `return { ... }` object literals are recognized — spreads and
 * conditional returns fall back to the `preserve` escape hatch.
 */
function applyHookReturnBindings(args: {
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

function resolveHookReturnNamespaces(
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

function asFunctionLike(node: ts.Node): ts.SignatureDeclaration | null {
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

function collectReturnNamespacesFrom(
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

function collectFromReturnExpression(
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

function mergeInto(
    out: Map<string, Set<string>>,
    key: string,
    values: Set<string>,
): void {
    if (!out.has(key)) out.set(key, new Set());
    const bucket = out.get(key)!;
    for (const v of values) bucket.add(v);
}

function absorbNamespaces(
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
