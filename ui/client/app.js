const $ = (sel) => document.querySelector(sel);

const els = {
    sourceLocale: $('#source-locale'),
    targetLocale: $('#target-locale'),
    search: $('#search'),
    missingOnly: $('#missing-only'),
    showContext: $('#show-context'),
    namespaces: $('#namespaces'),
    rows: $('#rows'),
    progressChip: $('#progress-chip'),
    toast: $('#toast'),
    themeToggle: $('#theme-toggle'),
    themeGlyph: $('#theme-toggle .theme-glyph'),
};

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
    showContext: false,
    theme: 'auto',
};

let renderJob = null;

let toastTimer = null;
function toast(msg, kind = 'info') {
    els.toast.textContent = msg;
    els.toast.classList.toggle('err', kind === 'err');
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

async function fetchJson(url, init) {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
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
            if (state.targetLocale !== data.target) return loadIndex();
        }
        state.index = data.namespaces;
        if (!state.activeNamespace || !state.index.some(n => n.name === state.activeNamespace)) {
            state.activeNamespace = state.index[0]?.name ?? null;
        }
        renderLocaleSelectors();
        renderNamespaces();
        renderProgressChip();
        renderRows();
    } catch (err) {
        toast(`Failed to load: ${err.message}`, 'err');
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
        li.innerHTML = `<div class="ns-button"><span style="font-style:italic;color:var(--ink-dim);font-family:var(--serif)">No namespaces yet — run <code style="font-family:var(--mono)">lexen extract</code>.</span></div>`;
        els.namespaces.appendChild(li);
        return;
    }
    for (const ns of state.index) {
        const li = document.createElement('li');
        li.className = 'ns-row';
        if (ns.name === state.activeNamespace) li.classList.add('active');
        if (ns.total > 0 && ns.filled >= ns.total) li.classList.add('complete');
        li.dataset.namespace = ns.name;
        const pct = ns.total > 0 ? ns.filled / ns.total : 0;

        const btn = document.createElement('button');
        btn.className = 'ns-button';
        btn.type = 'button';

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
            els.entries?.scrollTo?.({top: 0});
        });

        li.appendChild(btn);
        els.namespaces.appendChild(li);
    }
}

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
    li.classList.toggle('complete', entry.total > 0 && entry.filled >= entry.total);
}

function renderProgressChip() {
    if (state.index.length === 0) {
        els.progressChip.textContent = '';
        return;
    }
    let total = 0, filled = 0;
    for (const ns of state.index) { total += ns.total; filled += ns.filled; }
    const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
    els.progressChip.innerHTML =
        `⟨${state.targetLocale}⟩ <strong>${filled.toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong> · ${pct}%`;
}

async function renderRows() {
    els.rows.innerHTML = '';
    if (!state.activeNamespace) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.textContent = 'Choose a namespace to begin.';
        els.rows.appendChild(p);
        return;
    }

    const loading = document.createElement('p');
    loading.className = 'empty';
    loading.textContent = `Loading ${state.activeNamespace}…`;
    els.rows.appendChild(loading);

    const ns = await loadNamespace(state.activeNamespace).catch(err => {
        toast(`Failed to load namespace: ${err.message}`, 'err');
        return null;
    });
    if (!ns || state.activeNamespace !== ns.name) return;

    els.rows.innerHTML = '';
    const head = document.createElement('header');
    head.className = 'entries-head';
    head.innerHTML = `
        <h2><em>Entries of</em> <code>${escapeHtml(ns.name)}</code></h2>
        <p class="pair">⟨${escapeHtml(state.sourceLocale)}⟩ → ⟨${escapeHtml(state.targetLocale)}⟩</p>
    `;
    els.rows.appendChild(head);

    const filtered = filterKeys(ns.keys);
    if (filtered.length === 0) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.textContent = state.missingOnly
            ? `Nothing left to translate in ${ns.name} for ⟨${state.targetLocale}⟩.`
            : 'No entries match.';
        els.rows.appendChild(p);
        return;
    }

    const job = {ns: ns.name, filtered, idx: 0};
    renderJob = job;
    renderNextChunk(job);
}

function renderNextChunk(job) {
    if (renderJob !== job) return;
    const slice = job.filtered.slice(job.idx, job.idx + CHUNK);
    for (let i = 0; i < slice.length; i++) {
        const row = renderRow(job.ns, slice[i]);
        if (job.idx === 0 && i === 0) row.classList.add('first');
        els.rows.appendChild(row);
    }
    job.idx += slice.length;

    if (job.idx >= job.filtered.length) return;

    const sentinel = document.createElement('div');
    sentinel.className = 'render-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.textContent = `${job.filtered.length - job.idx} more below`;
    els.rows.appendChild(sentinel);

    const obs = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting && renderJob === job) {
            obs.disconnect();
            sentinel.remove();
            renderNextChunk(job);
        }
    }, {rootMargin: '600px 0px'});
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

    const keyLabel = document.createElement('span');
    keyLabel.className = 'entry-key';
    keyLabel.textContent = k.key;
    row.appendChild(keyLabel);

    const left = document.createElement('div');
    left.className = 'entry-source';

    const sourceVal = k.values[state.sourceLocale] ?? '';
    const src = document.createElement('p');
    src.className = 'entry-source-text' + (sourceVal ? '' : ' is-empty');
    if (sourceVal) {
        src.innerHTML = highlightPlaceholders(sourceVal);
    } else {
        src.textContent = '— empty in source —';
    }
    left.appendChild(src);

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

    const targetVal = state.targetLocale === state.sourceLocale
        ? sourceVal
        : (k.values[state.targetLocale] ?? '');

    const ta = document.createElement('textarea');
    ta.className = 'entry-textarea';
    ta.value = targetVal;
    ta.spellcheck = true;
    ta.dir = 'auto';
    ta.rows = Math.max(2, Math.min(6, Math.ceil((targetVal.length || 1) / 60) + 1));
    ta.dataset.namespace = namespace;
    ta.dataset.key = k.key;
    if (state.targetLocale === state.sourceLocale) {
        ta.readOnly = true;
        ta.title = 'Switch the target locale to translate.';
    } else if (targetVal) {
        ta.dataset.status = 'saved';
    }

    const note = document.createElement('p');
    note.className = 'entry-note';

    let lastSaved = targetVal;
    const save = async () => {
        if (ta.readOnly) return;
        const value = ta.value;
        if (value === lastSaved) return;
        const wasFilled = lastSaved.length > 0;
        const nowFilled = value.length > 0;
        ta.dataset.status = 'saving';
        note.textContent = '';
        note.className = 'entry-note';
        try {
            const body = await fetchJson('/api/translate', {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({namespace, key: k.key, locale: state.targetLocale, value}),
            });
            lastSaved = value;
            k.values[state.targetLocale] = value;

            if (state.targetLocale !== state.sourceLocale && wasFilled !== nowFilled) {
                const idxEntry = state.index.find(n => n.name === namespace);
                if (idxEntry) {
                    idxEntry.filled += nowFilled ? 1 : -1;
                    updateNamespaceProgress(namespace);
                    renderProgressChip();
                }
            }

            const drift = placeholderDiff(k.sourcePlaceholders, body.placeholders ?? []);
            if (body.malformed) {
                ta.dataset.status = 'err';
                note.textContent = 'Malformed ICU placeholders — check your braces.';
                note.className = 'entry-note err';
            } else if (drift) {
                ta.dataset.status = 'warn';
                note.textContent = drift;
                note.className = 'entry-note warn';
            } else if (nowFilled) {
                ta.dataset.status = 'saved';
            } else {
                delete ta.dataset.status;
            }
        } catch (err) {
            ta.dataset.status = 'err';
            note.textContent = `Save failed: ${err.message}`;
            note.className = 'entry-note err';
            toast(`Save failed: ${err.message}`, 'err');
        }
    };
    ta.addEventListener('blur', save);

    ta.addEventListener('keydown', (e) => {
        // Cmd/Ctrl+Enter → save and advance to next textarea
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            save().then(() => focusNextTextarea(ta));
        } else if (e.key === 'Escape') {
            e.preventDefault();
            ta.blur();
        }
    });

    right.appendChild(ta);
    right.appendChild(note);

    row.appendChild(left);
    row.appendChild(right);
    return row;
}

function focusNextTextarea(current) {
    const all = [...els.rows.querySelectorAll('textarea.entry-textarea:not([readonly])')];
    const idx = all.indexOf(current);
    const next = all[idx + 1];
    if (next) {
        next.focus();
        next.scrollIntoView({block: 'center', behavior: 'smooth'});
    }
}

// Wrap {placeholder} occurrences in a styled <code> for inline highlighting.
// Doesn't try to handle nested ICU (plural/select); those render as plain text.
function highlightPlaceholders(text) {
    return escapeHtml(text).replace(/\{[^{}]*\}/g, (m) => `<code class="ph">${m}</code>`);
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
    return parts.join('; ');
}

function escapeHtml(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

// ─── Theme ──────────────────────────────────────────
const THEME_GLYPHS = {auto: '◐', light: '☀', dark: '☾'};
function applyTheme(t) {
    state.theme = t;
    if (t === 'auto') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', t);
    }
    els.themeGlyph.textContent = THEME_GLYPHS[t];
    els.themeToggle.title = `Theme: ${t}`;
    try { localStorage.setItem('lexen.theme', t); } catch {}
}
function nextTheme(t) {
    return t === 'auto' ? 'light' : t === 'light' ? 'dark' : 'auto';
}

// ─── Wiring ─────────────────────────────────────────
els.targetLocale.addEventListener('change', e => {
    state.targetLocale = e.target.value;
    loadIndex();
});
els.search.addEventListener('input', e => {
    state.search = e.target.value;
    renderRows();
});
els.missingOnly.addEventListener('change', e => {
    state.missingOnly = e.target.checked;
    try { localStorage.setItem('lexen.missingOnly', String(state.missingOnly)); } catch {}
    renderRows();
});
els.showContext.addEventListener('change', e => {
    state.showContext = e.target.checked;
    document.body.classList.toggle('show-context', state.showContext);
    try { localStorage.setItem('lexen.showContext', String(state.showContext)); } catch {}
});
els.themeToggle.addEventListener('click', () => applyTheme(nextTheme(state.theme)));

document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl+K — focus search
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        els.search.focus();
        els.search.select();
    }
});

// Restore persisted preferences
try {
    const t = localStorage.getItem('lexen.theme');
    applyTheme(t === 'light' || t === 'dark' ? t : 'auto');
    const mo = localStorage.getItem('lexen.missingOnly');
    if (mo === 'true') { state.missingOnly = true; els.missingOnly.checked = true; }
    const sc = localStorage.getItem('lexen.showContext');
    if (sc === 'true') {
        state.showContext = true;
        els.showContext.checked = true;
        document.body.classList.add('show-context');
    }
} catch {}

loadIndex();
