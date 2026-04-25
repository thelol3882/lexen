import path from 'path';

import type {Config} from '../types.js';

export type NamespaceScope = 'global' | 'widget' | 'feature';

export interface ResolvedScope {
    scope: NamespaceScope;
    /** Widget/feature/global name (first segment after the widget prefix, or the whole name). */
    name: string;
    /**
     * Sub-path for widget namespaces deeper than `widget.<name>`, e.g.
     * `widget.dashboard.academyStats` → name:'dashboard', subPath:'academyStats'.
     * Means "read/write under that subtree of the widget's locale file".
     */
    subPath?: string;
}

export function resolveNamespaceScope(
    config: Config,
    namespace: string,
): ResolvedScope {
    // Any top-level key of the global messages file is a global sub-namespace.
    // See Config.globalSubNamespaces.
    if (config.globalSubNamespaces.has(namespace)) {
        return {scope: 'global', name: namespace};
    }

    const widgetPrefix = config.layout.widgetNamespacePrefix;
    if (widgetPrefix && config.layout.widget) {
        const prefix = widgetPrefix + '.';
        if (namespace.startsWith(prefix)) {
            const rest = namespace.slice(prefix.length);
            if (!rest.includes('.')) {
                return {scope: 'widget', name: rest};
            }
            // `widget.<name>.<subPath>` — deeper path inside the widget's file.
            const dotIdx = rest.indexOf('.');
            return {
                scope: 'widget',
                name: rest.slice(0, dotIdx),
                subPath: rest.slice(dotIdx + 1),
            };
        }
    }

    return {scope: 'feature', name: namespace};
}

export function resolveLocalePath(config: Config, namespace: string, locale: string): string {
    const {scope, name} = resolveNamespaceScope(config, namespace);

    let rel: string;
    if (scope === 'global') {
        rel = (config.layout.global ?? '').replace(/\{locale\}/g, locale);
    } else if (scope === 'widget') {
        rel = (config.layout.widget ?? '')
            .replace(/\{widget\}/g, name)
            .replace(/\{locale\}/g, locale);
    } else {
        rel = config.layout.feature
            .replace(/\{namespace\}/g, name)
            .replace(/\{locale\}/g, locale);
    }
    return path.join(config.absSrcDir, rel);
}

export function inferNamespaceFromPath(config: Config, relFile: string): string | null {
    const featuresDir = config.layout.featuresDir;
    if (!featuresDir) return null;
    const prefix = featuresDir.replace(/\\/g, '/') + '/';
    const normalized = relFile.replace(/\\/g, '/');
    if (!normalized.startsWith(prefix)) return null;
    const rest = normalized.slice(prefix.length);
    const slash = rest.indexOf('/');
    return slash === -1 ? rest : rest.slice(0, slash);
}
