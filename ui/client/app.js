// Lexen translator UI — vanilla ES module, no build step.

const $ = (sel) => document.querySelector(sel);

const els = {
    sourceLocale: $('#source-locale'),
    targetLocale: $('#target-locale'),
    search: $('#search'),
    missingOnly: $('#missing-only'),
    namespaces: $('#namespaces'),
    rows: $('#rows'),
    toast: $('#toast'),
};

const state = {
    locales: [],
    sourceLocale: '',
    targetLocale: '',
    namespaces: [], // [{name, keys: [{key, values, sourcePlaceholders, usages}]}]
    activeNamespace: null,
    search: '',
    missingOnly: false,
};

let toastTimer = null;
function toast(msg, kind = 'info') {
    els.toast.textContent = msg;
    els.toast.classList.toggle('err', kind === 'err');
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
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
    renderRows();
}

function renderLocaleSelectors() {
    els.sourceLocale.innerHTML = '';
    for (const l of state.locales) {
        const opt = document.createElement('option');
        opt.value = l;
        opt.textContent = l;
        if (l === state.sourceLocale) opt.selected = true;
        els.sourceLocale.appendChild(opt);
    }
    els.targetLocale.innerHTML = '';
    for (const l of state.locales) {
        const opt = document.createElement('option');
        opt.value = l;
        opt.textContent = l + (l === state.sourceLocale ? ' (source)' : '');
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
        const p = document.createElement('p');
        p.className = 'empty';
        p.style.padding = '1rem';
        p.style.color = 'var(--text-dim)';
        p.textContent = 'No namespaces extracted. Run `lexen extract` first.';
        els.namespaces.appendChild(p);
        return;
    }
    for (const ns of state.namespaces) {
        const btn = document.createElement('button');
        btn.className = 'ns' + (ns.name === state.activeNamespace ? ' active' : '');
        btn.type = 'button';
        const {filled, total} = progressFor(ns, state.targetLocale);
        btn.innerHTML = `
            <div>${escapeHtml(ns.name)}</div>
            <div class="meta">
                <span>${filled}/${total}</span>
                <span>${total > 0 ? Math.round((filled / total) * 100) : 0}%</span>
            </div>
            <progress value="${filled}" max="${total || 1}"></progress>
        `;
        btn.addEventListener('click', () => {
            state.activeNamespace = ns.name;
            renderNamespaces();
            renderRows();
        });
        els.namespaces.appendChild(btn);
    }
}

function renderRows() {
    els.rows.innerHTML = '';
    const ns = state.namespaces.find(n => n.name === state.activeNamespace);
    if (!ns) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.textContent = 'Select a namespace from the left.';
        els.rows.appendChild(p);
        return;
    }
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
        p.textContent = 'No matching keys.';
        els.rows.appendChild(p);
        return;
    }

    for (const k of filtered) {
        els.rows.appendChild(renderRow(ns.name, k));
    }
}

function renderRow(namespace, k) {
    const row = document.createElement('div');
    row.className = 'row';

    // Source side
    const left = document.createElement('div');
    const keyEl = document.createElement('div');
    keyEl.className = 'key';
    keyEl.textContent = k.key;
    left.appendChild(keyEl);

    const sourceVal = k.values[state.sourceLocale] ?? '';
    const src = document.createElement('div');
    src.className = 'source' + (sourceVal ? '' : ' empty-source');
    src.textContent = sourceVal || '(empty in source)';
    left.appendChild(src);

    if (k.sourcePlaceholders.length > 0) {
        const ph = document.createElement('div');
        ph.className = 'placeholders';
        for (const name of k.sourcePlaceholders) {
            const span = document.createElement('span');
            span.className = 'ph';
            span.textContent = '{' + name + '}';
            ph.appendChild(span);
        }
        left.appendChild(ph);
    }

    if (k.usages.length > 0) {
        const u = document.createElement('div');
        u.className = 'usages';
        for (const usage of k.usages) {
            const line = document.createElement('span');
            line.textContent = `${usage.file}:${usage.line}`;
            u.appendChild(line);
        }
        left.appendChild(u);
    }

    // Target side
    const right = document.createElement('div');
    right.className = 'target';

    const targetVal = state.targetLocale === state.sourceLocale
        ? sourceVal
        : (k.values[state.targetLocale] ?? '');

    const ta = document.createElement('textarea');
    ta.value = targetVal;
    ta.spellcheck = true;
    ta.dir = 'auto';
    if (state.targetLocale === state.sourceLocale) {
        ta.readOnly = true;
        ta.title = 'Editing source locale is disabled — switch target locale to translate.';
    }

    const status = document.createElement('div');
    status.className = 'status';

    let lastSaved = targetVal;
    ta.addEventListener('blur', async () => {
        if (ta.readOnly) return;
        const value = ta.value;
        if (value === lastSaved) return;
        status.textContent = 'saving…';
        status.className = 'status';
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
            if (!res.ok || !body.ok) {
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            lastSaved = value;
            k.values[state.targetLocale] = value;
            const drift = placeholderDiff(k.sourcePlaceholders, body.placeholders ?? []);
            if (body.malformed) {
                status.textContent = 'malformed ICU placeholders';
                status.className = 'status err';
            } else if (drift) {
                status.textContent = drift;
                status.className = 'status warn';
            } else {
                status.textContent = '✓ saved';
                status.className = 'status ok';
            }
            renderNamespaces(); // update progress bars
        } catch (err) {
            status.textContent = `error: ${err.message}`;
            status.className = 'status err';
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
    if (missing.length) parts.push('missing: ' + missing.map(p => '{' + p + '}').join(', '));
    if (extra.length) parts.push('extra: ' + extra.map(p => '{' + p + '}').join(', '));
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
