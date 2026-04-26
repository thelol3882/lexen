// Lexen translator UI — vanilla ES module.
// DOM is structured like a dictionary: rail = table of contents, each row = entry.

const $ = (sel) => document.querySelector(sel);

const els = {
    sourceLocale: $('#source-locale'),
    targetLocale: $('#target-locale'),
    search: $('#search'),
    missingOnly: $('#missing-only'),
    namespaces: $('#namespaces'),
    rows: $('#rows'),
    railFoot: $('#rail-foot'),
    toast: $('#toast'),
};

const state = {
    locales: [],
    sourceLocale: '',
    targetLocale: '',
    namespaces: [],
    activeNamespace: null,
    search: '',
    missingOnly: false,
};

// Cap the per-item animation delay so a 7000-key namespace doesn't cascade
// for 16+ seconds (16ms × 1000 = 16s). After this index everything appears
// in the same frame.
const STAGGER_CAP = 30;

// Roman numerals so the rail reads like a printed table of contents.
function toRoman(n) {
    const map = [
        ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400],
        ['C', 100], ['XC', 90], ['L', 50], ['XL', 40],
        ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1],
    ];
    let out = '';
    for (const [s, v] of map) while (n >= v) { out += s; n -= v; }
    return out.toLowerCase();
}

let toastTimer = null;
function toast(msg, kind = 'info') {
    els.toast.textContent = msg;
    els.toast.classList.toggle('err', kind === 'err');
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

async function loadState() {
    try {
        const res = await fetch('/api/state');
        if (!res.ok) throw new Error(`GET /api/state → ${res.status}`);
        const data = await res.json();
        state.locales = data.locales;
        state.sourceLocale = data.sourceLocale;
        state.namespaces = data.namespaces;
        if (!state.targetLocale || !state.locales.includes(state.targetLocale)) {
            state.targetLocale =
                state.locales.find(l => l !== state.sourceLocale) ?? state.sourceLocale;
        }
        if (!state.activeNamespace || !state.namespaces.some(n => n.name === state.activeNamespace)) {
            state.activeNamespace = state.namespaces[0]?.name ?? null;
        }
        renderAll();
    } catch (err) {
        toast(`Failed to load: ${err.message}`, 'err');
    }
}

function renderAll() {
    renderLocaleSelectors();
    renderNamespaces();
    renderRailFoot();
    renderRows();
}

function renderLocaleSelectors() {
    els.sourceLocale.innerHTML = '';
    for (const l of state.locales) {
        const opt = document.createElement('option');
        opt.value = l;
        opt.textContent = `⟨${l}⟩`;
        if (l === state.sourceLocale) opt.selected = true;
        els.sourceLocale.appendChild(opt);
    }
    els.targetLocale.innerHTML = '';
    for (const l of state.locales) {
        const opt = document.createElement('option');
        opt.value = l;
        opt.textContent = `⟨${l}⟩` + (l === state.sourceLocale ? '  (source)' : '');
        if (l === state.targetLocale) opt.selected = true;
        els.targetLocale.appendChild(opt);
    }
}

function progressFor(ns, locale) {
    const total = ns.keys.length;
    let filled = 0;
    for (const k of ns.keys) if (k.values[locale]) filled++;
    return {filled, total};
}

function renderNamespaces() {
    els.namespaces.innerHTML = '';
    if (state.namespaces.length === 0) {
        const li = document.createElement('li');
        li.className = 'ns-row';
        li.innerHTML = `<div class="ns-button" style="grid-template-columns:1fr">
            <span style="font-style:italic;color:var(--ink-dim);font-family:var(--serif)">No namespaces extracted yet.<br>Run <code style="font-family:var(--mono)">lexen extract</code> first.</span>
        </div>`;
        els.namespaces.appendChild(li);
        return;
    }
    state.namespaces.forEach((ns, i) => {
        const {filled, total} = progressFor(ns, state.targetLocale);
        const li = document.createElement('li');
        li.className = 'ns-row' + (ns.name === state.activeNamespace ? ' active' : '');
        li.style.setProperty('--i', String(Math.min(i, STAGGER_CAP)));
        li.dataset.namespace = ns.name;
        const pct = total > 0 ? filled / total : 0;

        const btn = document.createElement('button');
        btn.className = 'ns-button';
        btn.type = 'button';

        const num = document.createElement('span');
        num.className = 'ns-num';
        num.textContent = toRoman(i + 1);

        const name = document.createElement('span');
        name.className = 'ns-name';
        name.textContent = ns.name;

        const meta = document.createElement('span');
        meta.className = 'ns-meta';
        const bar = document.createElement('span');
        bar.className = 'ns-bar';
        bar.style.setProperty('--p', String(pct));
        bar.dataset.role = 'bar';
        const frac = document.createElement('span');
        frac.className = 'ns-frac';
        frac.textContent = `${filled}⁄${total}`;
        frac.dataset.role = 'frac';
        meta.appendChild(bar);
        meta.appendChild(frac);

        btn.appendChild(num);
        btn.appendChild(name);
        btn.appendChild(meta);

        btn.addEventListener('click', () => {
            state.activeNamespace = ns.name;
            renderNamespaces();
            renderRows();
        });

        li.appendChild(btn);
        els.namespaces.appendChild(li);
    });
}

// Update only the affected namespace's progress bar + fraction in place.
// Avoids re-rendering the whole rail (and re-triggering the stagger animation)
// every time the translator saves a string.
function updateNamespaceProgress(name) {
    const ns = state.namespaces.find(n => n.name === name);
    if (!ns) return;
    const li = els.namespaces.querySelector(`[data-namespace="${CSS.escape(name)}"]`);
    if (!li) return;
    const {filled, total} = progressFor(ns, state.targetLocale);
    const bar = li.querySelector('[data-role="bar"]');
    const frac = li.querySelector('[data-role="frac"]');
    if (bar) bar.style.setProperty('--p', String(total > 0 ? filled / total : 0));
    if (frac) frac.textContent = `${filled}⁄${total}`;
}

function renderRailFoot() {
    if (state.namespaces.length === 0) {
        els.railFoot.textContent = '';
        return;
    }
    let totalKeys = 0, totalFilled = 0;
    for (const ns of state.namespaces) {
        totalKeys += ns.keys.length;
        for (const k of ns.keys) if (k.values[state.targetLocale]) totalFilled++;
    }
    const pct = totalKeys > 0 ? Math.round((totalFilled / totalKeys) * 100) : 0;
    els.railFoot.textContent =
        `In ${state.namespaces.length} namespace(s), ${totalFilled} of ${totalKeys} keys translated for ⟨${state.targetLocale}⟩ — ${pct}%.`;
}

function renderRows() {
    els.rows.innerHTML = '';
    const ns = state.namespaces.find(n => n.name === state.activeNamespace);
    if (!ns) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.innerHTML = `<span class="dropcap">S</span>elect a namespace from the table of contents to begin.`;
        els.rows.appendChild(p);
        return;
    }

    const head = document.createElement('header');
    head.className = 'entries-head';
    head.innerHTML = `
        <h2>The entries of <span class="ns-display">${escapeHtml(ns.name)}</span></h2>
        <p class="pair"><code>⟨${escapeHtml(state.sourceLocale)}⟩</code> ⟶ <code>⟨${escapeHtml(state.targetLocale)}⟩</code></p>
    `;
    els.rows.appendChild(head);

    const q = state.search.trim().toLowerCase();
    const filtered = ns.keys.filter(k => {
        if (state.missingOnly && k.values[state.targetLocale]) return false;
        if (!q) return true;
        if (k.key.toLowerCase().includes(q)) return true;
        const src = (k.values[state.sourceLocale] ?? '').toLowerCase();
        return src.includes(q);
    });

    if (filtered.length === 0) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.innerHTML = state.missingOnly && ns.keys.length > 0
            ? `<span class="dropcap">A</span>ll keys in this namespace are translated for ⟨${escapeHtml(state.targetLocale)}⟩.`
            : `<span class="dropcap">N</span>o entries match your search.`;
        els.rows.appendChild(p);
        return;
    }

    filtered.forEach((k, i) => {
        const row = renderRow(ns.name, k);
        row.style.setProperty('--i', String(Math.min(i, STAGGER_CAP)));
        els.rows.appendChild(row);
    });
}

function renderRow(namespace, k) {
    const row = document.createElement('article');
    row.className = 'entry';

    // Source side — set as a dictionary headword.
    const left = document.createElement('div');
    left.className = 'entry-source';

    const keyEl = document.createElement('div');
    keyEl.className = 'entry-key';
    keyEl.textContent = k.key;
    left.appendChild(keyEl);

    const sourceVal = k.values[state.sourceLocale] ?? '';
    const src = document.createElement('p');
    src.className = 'entry-source-text' + (sourceVal ? '' : ' is-empty');
    src.textContent = sourceVal || '— empty in source —';
    left.appendChild(src);

    if (k.sourcePlaceholders.length > 0) {
        const ph = document.createElement('ul');
        ph.className = 'entry-placeholders';
        for (const name of k.sourcePlaceholders) {
            const li = document.createElement('li');
            li.textContent = '{' + name + '}';
            ph.appendChild(li);
        }
        left.appendChild(ph);
    }

    if (k.usages.length > 0) {
        const u = document.createElement('div');
        u.className = 'entry-usages';
        for (const usage of k.usages) {
            const line = document.createElement('span');
            line.textContent = `${usage.file}:${usage.line}`;
            u.appendChild(line);
        }
        left.appendChild(u);
    }

    // Target side — the translator's hand.
    const right = document.createElement('div');
    right.className = 'entry-target';

    const label = document.createElement('span');
    label.className = 'entry-target-label';
    label.innerHTML = `Translation <code>⟨${escapeHtml(state.targetLocale)}⟩</code>`;
    right.appendChild(label);

    const targetVal = state.targetLocale === state.sourceLocale
        ? sourceVal
        : (k.values[state.targetLocale] ?? '');

    const ta = document.createElement('textarea');
    ta.className = 'entry-textarea';
    ta.value = targetVal;
    ta.spellcheck = true;
    ta.dir = 'auto';
    ta.rows = Math.max(2, Math.min(6, Math.ceil((targetVal.length || 1) / 60) + 1));
    if (state.targetLocale === state.sourceLocale) {
        ta.readOnly = true;
        ta.title = 'The source locale is read-only — switch the target to translate.';
    }

    const status = document.createElement('p');
    status.className = 'entry-status';

    let lastSaved = targetVal;
    ta.addEventListener('blur', async () => {
        if (ta.readOnly) return;
        const value = ta.value;
        if (value === lastSaved) return;
        status.innerHTML = `<span class="glyph">⌛</span>setting type…`;
        status.className = 'entry-status';
        try {
            const res = await fetch('/api/translate', {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    namespace,
                    key: k.key,
                    locale: state.targetLocale,
                    value,
                }),
            });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);

            lastSaved = value;
            k.values[state.targetLocale] = value;
            const drift = placeholderDiff(k.sourcePlaceholders, body.placeholders ?? []);
            if (body.malformed) {
                status.innerHTML = `<span class="glyph">⚠</span>malformed ICU placeholders`;
                status.className = 'entry-status err';
            } else if (drift) {
                status.innerHTML = `<span class="glyph">¶</span>${escapeHtml(drift)}`;
                status.className = 'entry-status warn';
            } else {
                status.innerHTML = `<span class="glyph">✓</span>set in ⟨${escapeHtml(state.targetLocale)}⟩`;
                status.className = 'entry-status ok';
            }
            ta.classList.add('flash-saved');
            setTimeout(() => ta.classList.remove('flash-saved'), 600);
            updateNamespaceProgress(namespace);
            renderRailFoot();
        } catch (err) {
            status.innerHTML = `<span class="glyph">✕</span>error: ${escapeHtml(err.message)}`;
            status.className = 'entry-status err';
            toast(`Save failed: ${err.message}`, 'err');
        }
    });

    right.appendChild(ta);
    right.appendChild(status);

    row.appendChild(left);
    row.appendChild(right);
    return row;
}

function placeholderDiff(expected, actual) {
    const exp = new Set(expected);
    const act = new Set(actual);
    const missing = [...exp].filter(p => !act.has(p));
    const extra = [...act].filter(p => !exp.has(p));
    if (missing.length === 0 && extra.length === 0) return null;
    const parts = [];
    if (missing.length) parts.push('missing ' + missing.map(p => '{' + p + '}').join(', '));
    if (extra.length) parts.push('extra ' + extra.map(p => '{' + p + '}').join(', '));
    return 'placeholder drift — ' + parts.join('; ');
}

function escapeHtml(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

els.targetLocale.addEventListener('change', e => {
    state.targetLocale = e.target.value;
    renderNamespaces();
    renderRailFoot();
    renderRows();
});
els.search.addEventListener('input', e => {
    state.search = e.target.value;
    renderRows();
});
els.missingOnly.addEventListener('change', e => {
    state.missingOnly = e.target.checked;
    renderRows();
});

loadState();
