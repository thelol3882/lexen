import fs from 'fs';
import path from 'path';

import {glob} from 'glob';

import type {Config, JsonObject, JsonValue} from './types.js';
import {c, log} from './util/log.js';
import {resolveLocalePath, resolveNamespaceScope} from './util/paths.js';

function readJsonFile(filePath: string): JsonObject {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
        return JSON.parse(raw) as JsonObject;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Malformed JSON at ${filePath}: ${msg}`);
    }
}

function writeJsonFile(filePath: string, data: JsonObject): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(filePath, JSON.stringify(sortObjectKeys(data), null, 2) + '\n', 'utf8');
}

export function sortObjectKeys<T extends JsonValue>(obj: T): T {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const sorted: JsonObject = {};
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortObjectKeys((obj as JsonObject)[key]);
    }
    return sorted as T;
}

export function getLeafKeys(obj: JsonObject, prefix: string = ''): string[] {
    let keys: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            keys = keys.concat(getLeafKeys(v as JsonObject, full));
        } else {
            keys.push(full);
        }
    }
    return keys;
}

export function getNestedValue(obj: JsonObject | undefined, dotPath: string): JsonValue | undefined {
    return dotPath.split('.').reduce<JsonValue | undefined>(
        (o, k) => (o && typeof o === 'object' && !Array.isArray(o) ? (o as JsonObject)[k] : undefined),
        obj,
    );
}

export function setNestedValue(obj: JsonObject, dotPath: string, value: JsonValue): void {
    const parts = dotPath.split('.');
    let current: JsonObject = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const next = current[parts[i]];
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
            current[parts[i]] = {};
        }
        current = current[parts[i]] as JsonObject;
    }
    current[parts[parts.length - 1]] = value;
}

export function deleteNestedValue(obj: JsonObject, dotPath: string): void {
    const parts = dotPath.split('.');
    const stack: {obj: JsonObject; key: string}[] = [];
    let current: JsonObject | undefined = obj;

    for (let i = 0; i < parts.length - 1; i++) {
        if (!current || typeof current !== 'object') return;
        stack.push({obj: current, key: parts[i]});
        const child: JsonValue | undefined = current[parts[i]];
        current = child && typeof child === 'object' && !Array.isArray(child) ? (child as JsonObject) : undefined;
    }

    if (current && typeof current === 'object') {
        delete current[parts[parts.length - 1]];
    }

    for (let i = stack.length - 1; i >= 0; i--) {
        const {obj: parent, key} = stack[i];
        const child = parent[key];
        if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) {
            delete parent[key];
        }
    }
}

/**
 * Read the slice of a locale file that holds this namespace's keys. Globals
 * live nested under their own key in a shared file; feature and widget
 * namespaces each own a dedicated file (root IS the namespace content).
 */
export function readNamespace(config: Config, namespace: string, locale: string): JsonObject {
    const filePath = resolveLocalePath(config, namespace, locale);
    const full = readJsonFile(filePath);
    const {scope, name, subPath} = resolveNamespaceScope(config, namespace);
    if (scope === 'global') {
        const nested = full[name];
        return nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as JsonObject) : {};
    }
    if (scope === 'widget' && subPath) {
        const nested = getNestedValue(full, subPath);
        return nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as JsonObject) : {};
    }
    return full;
}

export function writeNamespace(config: Config, namespace: string, locale: string, data: JsonObject): void {
    const filePath = resolveLocalePath(config, namespace, locale);
    const {scope, name, subPath} = resolveNamespaceScope(config, namespace);
    if (scope === 'global') {
        const full = readJsonFile(filePath);
        full[name] = data;
        writeJsonFile(filePath, full);
        return;
    }
    if (scope === 'widget' && subPath) {
        const full = readJsonFile(filePath);
        setNestedValue(full, subPath, data);
        writeJsonFile(filePath, full);
        return;
    }
    writeJsonFile(filePath, data);
}

export function sortAll(config: Config): {sorted: number; skipped: number} {
    const files = new Set<string>();

    // Glob *.json across all feature locale dirs (not just configured locales)
    // so stale files don't drift silently out of sort.
    const featureGlob = config.layout.feature
        .replace(/\{namespace\}/g, '*')
        .replace(/\{locale\}/g, '*');
    for (const rel of glob.sync(featureGlob, {cwd: config.absSrcDir, windowsPathsNoEscape: true})) {
        files.add(rel);
    }

    if (config.layout.widget) {
        const widgetGlob = config.layout.widget
            .replace(/\{widget\}/g, '*')
            .replace(/\{locale\}/g, '*');
        for (const rel of glob.sync(widgetGlob, {cwd: config.absSrcDir, windowsPathsNoEscape: true})) {
            files.add(rel);
        }
    }

    if (config.layout.global) {
        for (const locale of config.locales) {
            const rel = config.layout.global.replace(/\{locale\}/g, locale);
            const abs = path.join(config.absSrcDir, rel);
            if (fs.existsSync(abs)) files.add(rel);
        }
    }

    let sorted = 0;
    let skipped = 0;

    for (const rel of files) {
        const abs = path.join(config.absSrcDir, rel);
        const data = readJsonFile(abs);
        const sortedData = sortObjectKeys(data);
        const original = JSON.stringify(data, null, 2) + '\n';
        const result = JSON.stringify(sortedData, null, 2) + '\n';
        if (original !== result) {
            fs.writeFileSync(abs, result, 'utf8');
            log(`  ${c.green}sorted${c.reset} ${rel}`);
            sorted++;
        } else {
            skipped++;
        }
    }

    return {sorted, skipped};
}

/**
 * Discover every namespace that has a locale file on disk. Used by validation
 * to reject unknown namespaces. Glob returns OS-native separators on Windows;
 * normalize before splitting.
 */
export function discoverValidNamespaces(config: Config): Set<string> {
    const valid = new Set<string>();

    if (config.layout.featuresDir) {
        const featureDirGlob = `${config.layout.featuresDir}/*/locales`;
        const featureDirs = glob.sync(featureDirGlob, {
            cwd: config.absSrcDir,
            windowsPathsNoEscape: true,
        });
        const featuresDepth = config.layout.featuresDir.split('/').length;
        for (const dir of featureDirs) {
            const parts = dir.replace(/\\/g, '/').split('/');
            const name = parts[featuresDepth];
            if (name) valid.add(name);
        }
    }

    if (config.layout.widgetsDir && config.layout.widgetNamespacePrefix) {
        const widgetDirGlob = `${config.layout.widgetsDir}/*/locales`;
        const widgetDirs = glob.sync(widgetDirGlob, {
            cwd: config.absSrcDir,
            windowsPathsNoEscape: true,
        });
        const widgetsDepth = config.layout.widgetsDir.split('/').length;
        for (const dir of widgetDirs) {
            const parts = dir.replace(/\\/g, '/').split('/');
            const name = parts[widgetsDepth];
            if (name) valid.add(`${config.layout.widgetNamespacePrefix}.${name}`);
        }
    }

    if (config.layout.global) {
        for (const locale of config.locales) {
            const rel = config.layout.global.replace(/\{locale\}/g, locale);
            const abs = path.join(config.absSrcDir, rel);
            if (!fs.existsSync(abs)) continue;
            try {
                const data = JSON.parse(fs.readFileSync(abs, 'utf8')) as JsonObject;
                for (const key of Object.keys(data)) valid.add(key);
            } catch {
                // ignore — malformed files are surfaced later
            }
        }
    }

    return valid;
}
