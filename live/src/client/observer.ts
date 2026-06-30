/**
 * @thelol3882/lexen-live — MutationObserver + click handler for marked text nodes.
 *
 * DEV-ONLY. Loaded via dynamic import() from provider.tsx — never bundled in prod.
 *
 * Responsibilities:
 *  1. Single MutationObserver on document.body — batched via rAF, WeakSet dedupe.
 *  2. TreeWalker(SHOW_TEXT) scans text nodes for the MARKER_START sentinel.
 *  3. WeakMap<Text, KeyRef> tracks which text node maps to which key.
 *  4. Attribute-strip sweep removes marker codepoints from
 *     value / placeholder / title / alt / aria-* after each batched mutation.
 *  5. Self-write disconnect/reconnect guard prevents feedback loops.
 *  6. alt/cmd-click listener: caretRangeFromPoint → nearest marked ancestor
 *     → decode → call onKeyClick(keyRef, rect).
 */

import type { KeyRef } from '../shared/protocol.js';
import { decode, stripMarkers } from './markers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObserverOptions {
    /** Registry populated by wrapMessages — maps marker id to KeyRef. */
    registry: Map<number, KeyRef>;
    /** Called when the user alt/cmd-clicks a marked text node. */
    onKeyClick: (keyRef: KeyRef, rect: DOMRect) => void;
}

// ---------------------------------------------------------------------------
// Attribute stripping
// ---------------------------------------------------------------------------

/** Attributes whose marker codepoints must be stripped after each render. */
const STRIP_ATTRS = [
    'value',
    'placeholder',
    'title',
    'alt',
    'content',
] as const;

/**
 * Marker codepoint presence check — test without resetting lastIndex by using
 * a fresh regex per call (avoid /g stateful lastIndex bugs).
 */
function hasMarkers(s: string): boolean {
    return /[​‌‍⁠]/.test(s);
}

/**
 * Strip marker codepoints from sensitive DOM attributes on `root` and all its
 * descendants.  Called inside the self-write guard (observer disconnected) to
 * avoid triggering another mutation cycle.
 */
function stripAttributes(root: Element): void {
    function walk(el: Element): void {
        // Fixed sensitive attributes
        for (const attr of STRIP_ATTRS) {
            const val = el.getAttribute(attr);
            if (val !== null && hasMarkers(val)) {
                el.setAttribute(attr, stripMarkers(val));
            }
        }
        // aria-* attributes
        for (const { name, value } of Array.from(el.attributes)) {
            if (name.startsWith('aria-') && hasMarkers(value)) {
                el.setAttribute(name, stripMarkers(value));
            }
        }
        for (const child of Array.from(el.children)) {
            walk(child);
        }
    }
    walk(root);
}

// ---------------------------------------------------------------------------
// Main observer init
// ---------------------------------------------------------------------------

const OBSERVE_OPTIONS: MutationObserverInit = {
    childList: true,
    subtree: true,
    characterData: true,
};

/**
 * Initialise the MutationObserver and click handler.
 * Returns a cleanup function — call it to disconnect and remove all listeners.
 */
export function initObserver(options: ObserverOptions): () => void {
    const { registry, onKeyClick } = options;

    /** Maps each marked Text node to its decoded KeyRef for fast click lookup. */
    const nodeMap = new WeakMap<Text, KeyRef>();

    /** Roots queued for processing in the next rAF batch. */
    const pendingRoots = new Set<Node>();

    let rafId = 0;
    let writing = false;
    let disposed = false;

    // -----------------------------------------------------------------------
    // Self-write guard: disconnect → mutate DOM → reconnect
    // -----------------------------------------------------------------------

    function pauseAndWrite(fn: () => void): void {
        observer.disconnect();
        writing = true;
        try {
            fn();
        } finally {
            writing = false;
            if (!disposed) {
                observer.observe(document.body, OBSERVE_OPTIONS);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Text-node indexing
    // -----------------------------------------------------------------------

    function indexSubtree(root: Node): void {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const elementsToStrip = new Set<Element>();

        let textNode: Text | null;
        while ((textNode = walker.nextNode() as Text | null) !== null) {
            const id = decode(textNode.data);
            if (id !== null) {
                const ref = registry.get(id);
                if (ref) {
                    nodeMap.set(textNode, ref);
                }
            }
        }

        // Collect nearest element ancestor for attribute stripping
        if (root.nodeType === Node.ELEMENT_NODE) {
            elementsToStrip.add(root as Element);
        } else if (root.parentElement) {
            elementsToStrip.add(root.parentElement);
        }

        if (elementsToStrip.size > 0) {
            pauseAndWrite(() => {
                for (const el of elementsToStrip) {
                    stripAttributes(el);
                }
            });
        }
    }

    function flushPending(): void {
        rafId = 0;
        if (pendingRoots.size === 0) return;
        const roots = Array.from(pendingRoots);
        pendingRoots.clear();
        for (const root of roots) {
            indexSubtree(root);
        }
    }

    // -----------------------------------------------------------------------
    // MutationObserver
    // -----------------------------------------------------------------------

    const observer = new MutationObserver((mutations) => {
        if (writing) return; // skip our own attribute-strip writes

        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                for (const node of Array.from(mutation.addedNodes)) {
                    pendingRoots.add(node);
                }
            } else if (
                mutation.type === 'characterData' &&
                mutation.target.parentElement
            ) {
                pendingRoots.add(mutation.target.parentElement);
            }
        }

        if (rafId === 0) {
            rafId = requestAnimationFrame(flushPending);
        }
    });

    // Initial full-body index
    pendingRoots.add(document.body);
    rafId = requestAnimationFrame(flushPending);

    observer.observe(document.body, OBSERVE_OPTIONS);

    // -----------------------------------------------------------------------
    // Alt/Cmd-click handler
    // -----------------------------------------------------------------------

    /**
     * Walk from `node` upward through the DOM looking for a Text node that is
     * registered in nodeMap.  Also checks first-child Text nodes of each element
     * ancestor (covers the common React pattern where text sits directly inside a
     * <span> or <p>).
     */
    function findMarkedNode(
        node: Node | null
    ): { textNode: Text; keyRef: KeyRef } | null {
        let current: Node | null = node;
        while (current) {
            if (current.nodeType === Node.TEXT_NODE) {
                const ref = nodeMap.get(current as Text);
                if (ref) return { textNode: current as Text, keyRef: ref };
            } else if (current.nodeType === Node.ELEMENT_NODE) {
                // Check direct Text children first (most common case)
                for (const child of Array.from(current.childNodes)) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const ref = nodeMap.get(child as Text);
                        if (ref) return { textNode: child as Text, keyRef: ref };
                    }
                }
            }
            current = current.parentNode;
        }
        return null;
    }

    function onClick(e: MouseEvent): void {
        // Only trigger on alt+click (Windows/Linux) or cmd+click (macOS)
        if (!e.altKey && !e.metaKey) return;

        // Resolve the node under the pointer
        type DocExt = Document & {
            caretRangeFromPoint?: (x: number, y: number) => Range | null;
            caretPositionFromPoint?: (
                x: number,
                y: number
            ) => { offsetNode: Node } | null;
        };
        const doc = document as DocExt;

        let targetNode: Node | null = null;
        if (doc.caretRangeFromPoint) {
            // Chromium / Safari
            targetNode =
                doc.caretRangeFromPoint(e.clientX, e.clientY)?.startContainer ??
                null;
        } else if (doc.caretPositionFromPoint) {
            // Firefox
            targetNode =
                doc.caretPositionFromPoint(e.clientX, e.clientY)?.offsetNode ??
                null;
        } else {
            targetNode = document.elementFromPoint(e.clientX, e.clientY);
        }

        const found = findMarkedNode(targetNode);
        if (!found) return;

        e.preventDefault();
        e.stopPropagation();

        // Anchor the panel to the element's bounding box
        const el = found.textNode.parentElement ?? document.body;
        const rect = el.getBoundingClientRect();
        onKeyClick(found.keyRef, rect);
    }

    document.addEventListener('click', onClick, true /* capture phase */);

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    return function cleanup(): void {
        disposed = true;
        observer.disconnect();
        document.removeEventListener('click', onClick, true);
        if (rafId !== 0) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
        pendingRoots.clear();
    };
}
