import fs from 'fs';
import path from 'path';

import ts from 'typescript';

import type {Config} from './types.js';

/**
 * Build a shared `ts.Program` once per run from the project's tsconfig. The
 * type-checker resolver needs a program (not a single source file) to walk
 * imports, cross-file symbols, and `paths` aliases.
 */
export function buildProgram(config: Config): {program: ts.Program; checker: ts.TypeChecker} {
    const tsconfigPath = locateTsconfig(config);
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
        throw new Error(
            `lexen: failed to read tsconfig at ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
        );
    }
    const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(tsconfigPath),
    );
    if (parsed.errors.length > 0) {
        const msg = parsed.errors
            .map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n'))
            .join('; ');
        throw new Error(`lexen: invalid tsconfig at ${tsconfigPath}: ${msg}`);
    }

    const program = ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
        projectReferences: parsed.projectReferences,
    });
    return {program, checker: program.getTypeChecker()};
}

function locateTsconfig(config: Config): string {
    const override = config.resolverResolved.tsconfig;
    if (override) {
        const abs = path.isAbsolute(override) ? override : path.join(config.projectRoot, override);
        if (!fs.existsSync(abs)) {
            throw new Error(`lexen: resolver.tsconfig points to a missing file: ${abs}`);
        }
        return abs;
    }
    const candidate = path.join(config.projectRoot, 'tsconfig.json');
    if (!fs.existsSync(candidate)) {
        throw new Error(
            `lexen: resolver "typechecker" needs a tsconfig.json at ${candidate} (or set resolver.tsconfig in i18n.config.json)`,
        );
    }
    return candidate;
}

/**
 * Resolve an expression to the concrete string values it can take. Returns
 * `null` when the type widens to plain `string` (or broader) — callers fall
 * back to static-literal-only behaviour plus configured `preserve` entries.
 */
export function resolveStringLiterals(
    node: ts.Expression,
    checker: ts.TypeChecker,
    depth: number = 0,
): string[] | null {
    // Guard against runaway recursion through mutually-referential types.
    if (depth > 8) return null;

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return [node.text];
    }

    if (ts.isTemplateExpression(node)) {
        return resolveTemplateExpression(node, checker, depth);
    }

    if (ts.isParenthesizedExpression(node)) {
        return resolveStringLiterals(node.expression, checker, depth);
    }

    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        // Prefer the cast type when narrower than the expression's own type.
        const castLiterals = literalsFromType(checker.getTypeFromTypeNode(node.type));
        if (castLiterals !== null) return castLiterals;
        return resolveStringLiterals(node.expression, checker, depth);
    }

    if (ts.isConditionalExpression(node)) {
        const whenTrue = resolveStringLiterals(node.whenTrue, checker, depth + 1);
        const whenFalse = resolveStringLiterals(node.whenFalse, checker, depth + 1);
        if (whenTrue === null || whenFalse === null) return null;
        return dedupe([...whenTrue, ...whenFalse]);
    }

    const type = checker.getTypeAtLocation(node);
    return literalsFromType(type);
}

function resolveTemplateExpression(
    node: ts.TemplateExpression,
    checker: ts.TypeChecker,
    depth: number,
): string[] | null {
    const parts: string[][] = [[node.head.text]];
    for (const span of node.templateSpans) {
        const holeValues = resolveStringLiterals(span.expression, checker, depth + 1);
        if (holeValues === null) return null;
        parts.push(holeValues);
        parts.push([span.literal.text]);
    }
    // Cartesian product of every segment.
    let combined: string[] = [''];
    for (const options of parts) {
        const next: string[] = [];
        for (const base of combined) {
            for (const opt of options) next.push(base + opt);
        }
        combined = next;
    }
    return dedupe(combined);
}

function literalsFromType(type: ts.Type): string[] | null {
    if (type.isStringLiteral()) return [type.value];

    if (type.isUnion()) {
        const out: string[] = [];
        for (const member of type.types) {
            if (member.isStringLiteral()) {
                out.push(member.value);
                continue;
            }
            // Skip undefined/null members — they can't produce a key at runtime.
            if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
            // General `string`, numeric, etc. → bail.
            return null;
        }
        return out.length > 0 ? dedupe(out) : null;
    }

    // Type-level template literals: `` `prefix.${SomeUnion}` ``.
    if ((type.flags & ts.TypeFlags.TemplateLiteral) !== 0) {
        const tl = type as ts.TemplateLiteralType;
        const texts = tl.texts;
        const segments = tl.types;
        const holeValues = segments.map(t => literalsFromType(t));
        if (holeValues.some(v => v === null)) return null;
        let combined: string[] = [texts[0]];
        for (let i = 0; i < segments.length; i++) {
            const holes = holeValues[i]!;
            const tail = texts[i + 1];
            const next: string[] = [];
            for (const base of combined) {
                for (const hole of holes) next.push(base + hole + tail);
            }
            combined = next;
        }
        return dedupe(combined);
    }

    return null;
}

function dedupe(arr: string[]): string[] {
    return [...new Set(arr)];
}
