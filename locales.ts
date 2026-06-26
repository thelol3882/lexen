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

// Values stored as a JSON array (e.g. "items": ["a", "b"]) are traversed as an
// index-keyed map so they surface under "items.0", "items.1", … — matching how
// next-intl resolves `t(`items.${i}`)`. Treating arrays as opaque leaves made
// extract see those keys as missing and overwrite the array with empty strings.
function isContainer(v: JsonValue | undefined): v is JsonObject | JsonValue[] {
    return !!v && typeof v === 'object';
}

function containerEntries(obj: JsonObject | JsonValue[]): [string, JsonValue][] {
    return Array.isArray(obj)
        ? obj.map((v, i) => [String(i), v] as [string, JsonValue])
        : Object.entries(obj);
}

export function getLeafKeys(obj: JsonObject | JsonValue[], prefix: string = ''): string[] {
    let keys: string[] = [];
    for (const [k, v] of containerEntries(obj)) {
        const full = prefix ? `${prefix}.${k}` : k;
        if (isContainer(v)) {
            keys = keys.concat(getLeafKeys(v, full));
        } else {
            keys.push(full);
        }
    }
    return keys;
}

export function getNestedValue(obj: JsonObject | undefined, dotPath: string): JsonValue | undefined {
    return dotPath.split('.').reduce<JsonValue | undefined>((o, k) => {
        if (!isContainer(o)) return undefined;
        if (Array.isArray(o)) {
            const idx = Number(k);
            return Number.isInteger(idx) && idx >= 0 && idx < o.length ? o[idx] : undefined;
        }
        return o[k];
    }, obj);
}

export function setNestedValue(obj: JsonObject, dotPath: string, value: JsonValue): void {
    const parts = dotPath.split('.');
    let current: JsonObject | JsonValue[] = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        const next: JsonValue | undefined = (current as JsonObject)[key];
        // Descend into existing containers (objects AND arrays) so writing a new
        // sibling key never clobbers an array-stored value back into an object.
        // Missing intermediate containers are created as objects (lexen's
        // canonical form); existing arrays are left as arrays.
        if (isContainer(next)) {
            current = next;
        } else {
            const child: JsonObject = {};
            (current as JsonObject)[key] = child;
            current = child;
        }
    }
    (current as JsonObject)[parts[parts.length - 1]] = value;
}

export function deleteNestedValue(obj: JsonObject, dotPath: string): void {
    const parts = dotPath.split('.');
    const stack: {obj: JsonObject | JsonValue[]; key: string}[] = [];
    let current: JsonObject | JsonValue[] | undefined = obj;

    for (let i = 0; i < parts.length - 1; i++) {
        if (!isContainer(current)) return;
        stack.push({obj: current, key: parts[i]});
        const child: JsonValue | undefined = (current as JsonObject)[parts[i]];
        current = isContainer(child) ? child : undefined;
    }

    if (isContainer(current)) {
        const leaf = parts[parts.length - 1];
        if (Array.isArray(current)) {
            const idx = Number(leaf);
            if (Number.isInteger(idx) && idx >= 0 && idx < current.length) current.splice(idx, 1);
        } else {
            delete current[leaf];
        }
    }

    // Prune containers that became empty after the delete.
    for (let i = stack.length - 1; i >= 0; i--) {
        const {obj: parent, key} = stack[i];
        const child = (parent as JsonObject)[key];
        const empty = isContainer(child)
            && (Array.isArray(child) ? child.length === 0 : Object.keys(child).length === 0);
        if (!empty) continue;
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else delete parent[key];
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
