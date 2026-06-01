import ts from 'typescript';

import type {CallExtractorConfig} from '../types.js';

export function collectHookAliases(
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

/**
 * Collect all local aliases for the callee name(s) in the given call-extractor
 * config. Mirrors `collectHookAliases` but accepts multiple names and an
 * optional package filter from `CallExtractorConfig`.
 */
export function collectCalleeAliases(
    sourceFile: ts.SourceFile,
    callCfg: CallExtractorConfig,
): Set<string> {
    const names = new Set(
        Array.isArray(callCfg.callee) ? callCfg.callee : [callCfg.callee],
    );
    const pkg = callCfg.package;
    const aliases = new Set<string>();

    for (const stmt of sourceFile.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;
        if (!stmt.importClause) continue;

        const moduleSpec = stmt.moduleSpecifier;
        if (pkg && ts.isStringLiteral(moduleSpec) && moduleSpec.text !== pkg) {
            continue;
        }

        const named = stmt.importClause.namedBindings;
        if (named && ts.isNamedImports(named)) {
            for (const element of named.elements) {
                const original = element.propertyName
                    ? element.propertyName.text
                    : element.name.text;
                if (names.has(original)) {
                    aliases.add(element.name.text);
                }
            }
        }
    }

    return aliases;
}
