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

const STAGGER_CAP = 30; // cap per-item animation index so 1000+ rows don't cascade for seconds
const CHUNK = 60;

const state = {
    locales: [],
    sourceLocale: '',
    targetLocale: '',
    index: [],
    namespaceCache: new Map(),
    activeNamespace: null,
    search: '',
    missingOnly: false,
};

// Token for the in-flight chunk loop — bumped on namespace switch / filter
// change so a stale loop bails out instead of mixing renders.
let renderJob = null;

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

async function fetchJson(url, init) {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        const msg = (body && body.error) || `HTTP ${res.status}`;
        throw new Error(`${url} → ${msg}`);
    }
    return body;
}

async function loadIndex() {
    try {
        const target = state.targetLocale || '';
        const url = '/api/index' + (target ? `?target=${encodeURIComponent(target)}` : '');
        const data = await fetchJson(url);
        state.locales = data.locales;
        state.sourceLocale = data.sourceLocale;
        if (!state.targetLocale || !state.locales.includes(state.targetLocale)) {
            state.targetLocale =
                state.locales.find(l => l !== state.sourceLocale) ?? state.sourceLocale;
            // First request used a default target; refetch counts for the real one.
            if (state.targetLocale !== data.target) return loadIndex();
        }
        state.index = data.namespaces;
        if (!state.activeNamespace || !state.index.some(n => n.name === state.activeNamespace)) {
            state.activeNamespace = state.index[0]?.name ?? null;
        }
        renderLocaleSelectors();
        renderNamespaces();
        renderRailFoot();
        renderRows();
    } catch (err) {
        toast(`Failed to load index: ${err.message}`, 'err');
    }
}

async function loadNamespace(name) {
    if (state.namespaceCache.has(name)) return state.namespaceCache.get(name);
    const data = await fetchJson(`/api/namespace?name=${encodeURIComponent(name)}`);
    state.namespaceCache.set(name, data);
    return data;
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

function renderNamespaces() {
    els.namespaces.innerHTML = '';
    if (state.index.length === 0) {
        const li = document.createElement('li');
        li.className = 'ns-row';
        li.innerHTML = `<div class="ns-button" style="grid-template-columns:1fr">
            <span style="font-style:italic;color:var(--ink-dim);font-family:var(--serif)">No namespaces extracted yet.<br>Run <code style="font-family:var(--mono)">lexen extract</code> first.</span>
        </div>`;
        els.namespaces.appendChild(li);
        return;
    }
    state.index.forEach((ns, i) => {
        const li = document.createElement('li');
        li.className = 'ns-row' + (ns.name === state.activeNamespace ? ' active' : '');
        li.style.setProperty('--i', String(Math.min(i, STAGGER_CAP)));
        li.dataset.namespace = ns.name;
        const pct = ns.total > 0 ? ns.filled / ns.total : 0;

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
        frac.textContent = `${ns.filled}⁄${ns.total}`;
        frac.dataset.role = 'frac';
        meta.appendChild(bar);
        meta.appendChild(frac);

        btn.appendChild(num);
        btn.appendChild(name);
        btn.appendChild(meta);

        btn.addEventListener('click', () => {
            if (state.activeNamespace === ns.name) return;
            state.activeNamespace = ns.name;
            for (const el of els.namespaces.querySelectorAll('.ns-row.active')) {
                el.classList.remove('active');
            }
            li.classList.add('active');
            renderRows();
        });

        li.appendChild(btn);
        els.namespaces.appendChild(li);
    });
}

// In-place — avoids re-rendering the whole rail (and re-triggering its stagger animation) on every save.
function updateNamespaceProgress(name) {
    const entry = state.index.find(n => n.name === name);
    if (!entry) return;
    const li = els.namespaces.querySelector(`[data-namespace="${CSS.escape(name)}"]`);
    if (!li) return;
    const bar = li.querySelector('[data-role="bar"]');
    const frac = li.querySelector('[data-role="frac"]');
    const pct = entry.total > 0 ? entry.filled / entry.total : 0;
    if (bar) bar.style.setProperty('--p', String(pct));
    if (frac) frac.textContent = `${entry.filled}⁄${entry.total}`;
}

function renderRailFoot() {
    if (state.index.length === 0) {
        els.railFoot.textContent = '';
        return;
    }
    let totalKeys = 0, totalFilled = 0;
    for (const ns of state.index) {
        totalKeys += ns.total;
        totalFilled += ns.filled;
    }
    const pct = totalKeys > 0 ? Math.round((totalFilled / totalKeys) * 100) : 0;
    els.railFoot.textContent =
        `In ${state.index.length} namespace(s), ${totalFilled} of ${totalKeys} keys translated for ⟨${state.targetLocale}⟩ — ${pct}%.`;
}

async function renderRows() {
    els.rows.innerHTML = '';

    if (!state.activeNamespace) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.innerHTML = `<span class="dropcap">S</span>elect a namespace from the table of contents to begin.`;
        els.rows.appendChild(p);
        return;
    }

    const placeholder = document.createElement('p');
    placeholder.className = 'empty';
    placeholder.innerHTML = `<span class="dropcap">L</span>oading entries for <code style="font-family:var(--mono);font-style:normal">${escapeHtml(state.activeNamespace)}</code>&hellip;`;
    els.rows.appendChild(placeholder);

    const ns = await loadNamespace(state.activeNamespace).catch(err => {
        toast(`Failed to load namespace: ${err.message}`, 'err');
        return null;
    });
    if (!ns || state.activeNamespace !== ns.name) return; // user moved on

    els.rows.innerHTML = '';
    const head = document.createElement('header');
    head.className = 'entries-head';
    head.innerHTML = `
        <h2>The entries of <span class="ns-display">${escapeHtml(ns.name)}</span></h2>
        <p class="pair"><code>⟨${escapeHtml(state.sourceLocale)}⟩</code> ⟶ <code>⟨${escapeHtml(state.targetLocale)}⟩</code></p>
    `;
    els.rows.appendChild(head);

    const filtered = filterKeys(ns.keys);

    if (filtered.length === 0) {
        const p = document.createElement('p');
        p.className = 'empty';
        const total = ns.keys.length;
        p.innerHTML = state.missingOnly && total > 0
            ? `<span class="dropcap">A</span>ll keys in this namespace are translated for ⟨${escapeHtml(state.targetLocale)}⟩.`
            : `<span class="dropcap">N</span>o entries match your search.`;
        els.rows.appendChild(p);
        return;
    }

    const job = {ns: ns.name, filtered, idx: 0};
    renderJob = job;
    renderNextChunk(job);
}

function renderNextChunk(job) {
    if (renderJob !== job) return; // superseded
    const slice = job.filtered.slice(job.idx, job.idx + CHUNK);
    for (let i = 0; i < slice.length; i++) {
        const row = renderRow(job.ns, slice[i]);
        const visIdx = job.idx + i;
        if (visIdx < STAGGER_CAP) row.style.setProperty('--i', String(visIdx));
        else row.classList.add('no-stagger');
        els.rows.appendChild(row);
    }
    job.idx += slice.length;

    if (job.idx >= job.filtered.length) return;

    const sentinel = document.createElement('div');
    sentinel.className = 'render-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.textContent = `${job.filtered.length - job.idx} more entries below…`;
    els.rows.appendChild(sentinel);

    const obs = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting && renderJob === job) {
            obs.disconnect();
            sentinel.remove();
            renderNextChunk(job);
        }
    }, {rootMargin: '600px 0px 600px 0px'});
    obs.observe(sentinel);
}

function filterKeys(keys) {
    const q = state.search.trim().toLowerCase();
    return keys.filter(k => {
        if (state.missingOnly && k.values[state.targetLocale]) return false;
        if (!q) return true;
        if (k.key.toLowerCase().includes(q)) return true;
        const src = (k.values[state.sourceLocale] ?? '').toLowerCase();
        return src.includes(q);
    });
}

function renderRow(namespace, k) {
    const row = document.createElement('article');
    row.className = 'entry';

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
        const wasFilled = lastSaved.length > 0;
        const nowFilled = value.length > 0;
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

            // Mutate cached index counts in place — avoids refetching /api/index.
            if (state.targetLocale !== state.sourceLocale && wasFilled !== nowFilled) {
                const idxEntry = state.index.find(n => n.name === namespace);
                if (idxEntry) {
                    idxEntry.filled += nowFilled ? 1 : -1;
                    updateNamespaceProgress(namespace);
                    renderRailFoot();
                }
            }

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
    // Filled counts are per-locale; refetch index. Per-namespace key cache
    // already contains values for every locale, so it's reused as-is.
    loadIndex();
});
els.search.addEventListener('input', e => {
    state.search = e.target.value;
    renderRows();
});
els.missingOnly.addEventListener('change', e => {
    state.missingOnly = e.target.checked;
    renderRows();
});

loadIndex();
