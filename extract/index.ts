import fs from 'fs';
import path from 'path';

import {glob} from 'glob';
import ts from 'typescript';

import {buildProgram} from '../extract-resolver.js';
import type {
    AutoPreserved,
    Config,
    ExtractOptions,
    ExtractResult,
    NamespaceKeys,
    ResolverMode,
    UnresolvedCall,
    UsageRecord,
} from '../types.js';
import {collectCalleeAliases, collectHookAliases} from './aliases.js';
import {collectConfiguredCalls} from './configured-calls.js';
import {callToNamespaces, collectTranslationCall} from './hook-calls.js';
import {applyHookReturnBindings} from './hook-return.js';
import {resolvePropFlowBindings} from './prop-flow.js';
import {bindingNames, getCallReceiverName, identifiersInBinding} from './ast-utils.js';

export {BARE_NAMESPACE} from './hook-calls.js';

interface ExtractCtx {
    config: Config;
    sourceFile: ts.SourceFile;
    relFile: string;
    featureFilter: string | null;
    namespaceKeys: NamespaceKeys;
    autoPreserved: AutoPreserved;
    namespaceUsages: UsageRecord[];
    unresolvedCalls: UnresolvedCall[];
    dynamicKeys: NamespaceKeys;
    checker: ts.TypeChecker | null;
    propFlow: boolean;
    /** Track `const {t} = someHook()` patterns by walking someHook's body. */
    hookReturnFlow: boolean;
    hookReturnCache: Map<ts.Symbol, Map<string, Set<string>>>;
    /** All program source files — for cross-file prop-flow caller lookup. */
    programSourceFiles: ts.SourceFile[];
    /** Optional context sink threaded to `collectTranslationCall`. */
    onKeyContext?: (key: string, namespaces: string[], call: ts.CallExpression) => void;
}

export function extractAll(config: Config, options: ExtractOptions = {}): ExtractResult {
    const {featureFilter = null, resolverOverride, onKeyContext} = options;
    const mode: ResolverMode = resolverOverride ?? config.resolverResolved.mode;

    const namespaceKeys: NamespaceKeys = new Map();
    const autoPreserved: AutoPreserved = new Map();
    const namespaceUsages: UsageRecord[] = [];
    const unresolvedCalls: UnresolvedCall[] = [];
    const dynamicKeys: NamespaceKeys = new Map();

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
            dynamicKeys,
            checker,
            propFlow: mode === 'typechecker' && config.resolverResolved.propFlow,
            hookReturnFlow: mode === 'typechecker',
            hookReturnCache,
            programSourceFiles,
            onKeyContext,
        });
    }

    return {namespaceKeys, autoPreserved, namespaceUsages, unresolvedCalls, dynamicKeys};
}

function extractFromSourceFile(ctx: ExtractCtx): void {
    const {config, sourceFile, relFile, featureFilter, namespaceKeys, autoPreserved, namespaceUsages, unresolvedCalls, dynamicKeys, checker, propFlow, hookReturnFlow, hookReturnCache, programSourceFiles, onKeyContext} = ctx;

    const recordUnresolved = (call: 'useTranslations' | 't' | 'call', arg: ts.Node, namespaces?: string[]): void => {
        const {line, character} = ts.getLineAndCharacterOfPosition(sourceFile, arg.getStart(sourceFile));
        const raw = arg.getText(sourceFile);
        const snippet = raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
        const entry: UnresolvedCall = {
            call,
            namespace: '<unresolved>',
            file: relFile,
            line: line + 1,
            column: character + 1,
            snippet,
        };
        if (namespaces !== undefined) entry.namespaces = namespaces;
        unresolvedCalls.push(entry);
    };
    // Primary hook drives hook-return resolution (custom `useXxx()` binders);
    // getTranslations & friends are never destructured, so the primary is right.
    const hookName = config.hook.name;
    const hookPackage = config.hook.package;

    // Union the import aliases of every configured hook (e.g. useTranslations
    // from next-intl AND getTranslations from next-intl/server). A single set
    // means the rest of the walker treats them uniformly.
    const hookAliases = new Set<string>();
    for (const hook of config.hooksResolved) {
        for (const alias of collectHookAliases(sourceFile, hook.name, hook.package)) {
            hookAliases.add(alias);
        }
    }

    // Collect aliases for every configured call extractor. Each callee name (or
    // array of names) may be imported under a different local alias.
    const configuredCallAliases = (config.calls ?? []).map(callCfg =>
        collectCalleeAliases(sourceFile, callCfg),
    );
    const hasConfiguredCallAliases = configuredCallAliases.some(a => a.size > 0);

    // Files with no direct hook import may still destructure translators from a
    // custom hook (e.g. `const {t} = useGroupPlayersTable()`). In typechecker
    // mode keep walking so the hook-return resolver can pick those up.
    // Also keep walking when the file imports a configured callee — route pages
    // import buildMetadata but often not useTranslations.
    if (hookAliases.size === 0 && !propFlow && !hookReturnFlow && !hasConfiguredCallAliases) return;

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

    // Run configured-call extraction even when there are no hook bindings in
    // this file — route page.tsx files import buildMetadata but not useTranslations.
    if (hasConfiguredCallAliases) {
        for (let i = 0; i < (config.calls ?? []).length; i++) {
            const callCfg = config.calls![i];
            const aliases = configuredCallAliases[i];
            if (aliases.size === 0) continue;
            collectConfiguredCalls(
                sourceFile,
                callCfg,
                aliases,
                featureFilter,
                namespaceKeys,
                namespaceUsages,
                unresolvedCalls,
                checker,
                relFile,
                recordUnresolved,
            );
        }
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
                (arg, namespaces) => recordUnresolved('t', arg, namespaces),
                dynamicKeys,
                onKeyContext,
            );
        }
        ts.forEachChild(node, collectKeys);
    };
    collectKeys(sourceFile);
}
