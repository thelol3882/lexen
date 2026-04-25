import fs from 'fs';
import path from 'path';

import type {Config, RawConfig, ResolverConfig, ResolverMode} from './types.js';

const DEFAULT_CONFIG_FILE = 'i18n.config.json';

export function loadConfig(projectRoot: string, configFile: string = DEFAULT_CONFIG_FILE): Config {
    const configPath = path.isAbsolute(configFile)
        ? configFile
        : path.join(projectRoot, configFile);

    if (!fs.existsSync(configPath)) {
        throw new Error(`i18n config not found: ${configPath}`);
    }

    let raw: RawConfig;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as RawConfig;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Malformed i18n config at ${configPath}: ${msg}`);
    }

    validate(raw, configPath);

    const absSrcDir = path.join(projectRoot, raw.srcDir);

    return {
        ...raw,
        projectRoot,
        configPath,
        absSrcDir,
        resolverResolved: normalizeResolver(raw.resolver),
        globalSubNamespaces: discoverGlobalSubNamespaces(raw, absSrcDir),
    };
}

function discoverGlobalSubNamespaces(raw: RawConfig, absSrcDir: string): Set<string> {
    const out = new Set<string>();
    if (raw.layout.globalNamespace) out.add(raw.layout.globalNamespace);
    if (!raw.layout.global) return out;
    for (const locale of raw.locales) {
        const rel = raw.layout.global.replace(/\{locale\}/g, locale);
        const abs = path.join(absSrcDir, rel);
        if (!fs.existsSync(abs)) continue;
        try {
            const data = JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
            for (const key of Object.keys(data)) out.add(key);
        } catch {
            // ignore — malformed files surface elsewhere
        }
    }
    return out;
}

function normalizeResolver(raw: RawConfig['resolver']): Config['resolverResolved'] {
    if (raw === undefined) {
        return {mode: 'ast', propFlow: false};
    }
    if (typeof raw === 'string') {
        return {mode: raw, propFlow: raw === 'typechecker'};
    }
    const mode: ResolverMode = raw.mode ?? 'ast';
    const propFlow = raw.propFlow ?? (mode === 'typechecker');
    return {mode, propFlow, tsconfig: raw.tsconfig};
}

function validateResolver(resolver: RawConfig['resolver'], configPath: string): void {
    const validModes: ResolverMode[] = ['ast', 'typechecker'];
    if (typeof resolver === 'string') {
        if (!validModes.includes(resolver)) {
            throw new Error(`${configPath}: "resolver" must be one of ${JSON.stringify(validModes)}, got "${resolver}"`);
        }
        return;
    }
    if (typeof resolver !== 'object' || resolver === null || Array.isArray(resolver)) {
        throw new Error(`${configPath}: "resolver" must be a string or object`);
    }
    const r = resolver as ResolverConfig;
    if (r.mode !== undefined && !validModes.includes(r.mode)) {
        throw new Error(`${configPath}: "resolver.mode" must be one of ${JSON.stringify(validModes)}`);
    }
    if (r.propFlow !== undefined && typeof r.propFlow !== 'boolean') {
        throw new Error(`${configPath}: "resolver.propFlow" must be a boolean`);
    }
    if (r.tsconfig !== undefined && typeof r.tsconfig !== 'string') {
        throw new Error(`${configPath}: "resolver.tsconfig" must be a string path`);
    }
}

function validate(cfg: RawConfig, configPath: string): void {
    const required = ['srcDir', 'locales', 'filePatterns', 'hook', 'layout'] as const;
    for (const key of required) {
        if (!(key in cfg)) {
            throw new Error(`${configPath}: missing required key "${key}"`);
        }
    }
    if (!Array.isArray(cfg.locales) || cfg.locales.length === 0) {
        throw new Error(`${configPath}: "locales" must be a non-empty array`);
    }
    if (!Array.isArray(cfg.filePatterns) || cfg.filePatterns.length === 0) {
        throw new Error(`${configPath}: "filePatterns" must be a non-empty array`);
    }
    if (!cfg.hook.name) {
        throw new Error(`${configPath}: "hook.name" is required`);
    }
    if (!cfg.layout.feature) {
        throw new Error(`${configPath}: "layout.feature" is required`);
    }
    // Widget support is opt-in: if any widget key is set, require the full trio
    // so extractor, validator, and runtime can't disagree on shape.
    const widgetKeys = ['widget', 'widgetNamespacePrefix', 'widgetsDir'] as const;
    const widgetSet = widgetKeys.filter(k => cfg.layout[k]);
    if (widgetSet.length > 0 && widgetSet.length < widgetKeys.length) {
        const missing = widgetKeys.filter(k => !cfg.layout[k]);
        throw new Error(
            `${configPath}: widget layout requires all of [${widgetKeys.join(', ')}], missing: [${missing.join(', ')}]`,
        );
    }
    if (cfg.defaultLocale && !cfg.locales.includes(cfg.defaultLocale)) {
        throw new Error(`${configPath}: defaultLocale "${cfg.defaultLocale}" is not in locales`);
    }
    if (cfg.resolver !== undefined) {
        validateResolver(cfg.resolver, configPath);
    }
    if (cfg.preserve !== undefined) {
        if (typeof cfg.preserve !== 'object' || Array.isArray(cfg.preserve) || cfg.preserve === null) {
            throw new Error(`${configPath}: "preserve" must be an object keyed by namespace`);
        }
        for (const [ns, spec] of Object.entries(cfg.preserve)) {
            if (spec !== '*' && !Array.isArray(spec)) {
                throw new Error(
                    `${configPath}: preserve["${ns}"] must be "*" or an array of prefix strings, got ${typeof spec}`,
                );
            }
            if (Array.isArray(spec)) {
                for (const p of spec) {
                    if (typeof p !== 'string' || !p) {
                        throw new Error(`${configPath}: preserve["${ns}"] entries must be non-empty strings`);
                    }
                }
            }
        }
    }
}
