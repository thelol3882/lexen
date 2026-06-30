/**
 * @thelol3882/lexen-live — marker codec unit tests
 *
 * Tests encode / decode / stripMarkers (src/client/markers.ts) and
 * wrapMessages (src/client/wrap.ts).
 *
 * Run from the lexen repo root (where tsx is installed):
 *   node_modules/.bin/tsx live/__tests__/markers.test.ts
 *
 * No test framework or external runtime dependencies — uses only
 * node:assert/strict (Node.js built-in).
 */

import assert from 'node:assert/strict';
import { encode, decode, stripMarkers } from '../src/client/markers.js';
import { wrapMessages } from '../src/client/wrap.js';
import {
    MARKER_START,
    MARKER_END,
    MARKER_LENGTH,
    MARKER_BODY_LENGTH,
    MAX_MARKER_IDS,
    SENTINEL_CODEPOINTS,
} from '../src/shared/markers-spec.js';

// ---------------------------------------------------------------------------
// Minimal test runner (no external deps)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL: ${name}`);
        console.error(`       ${err instanceof Error ? err.message : String(err)}`);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// encode / decode — basic structural tests
// ---------------------------------------------------------------------------

console.log('\n-- encode / decode --');

test('encode produces exactly MARKER_LENGTH characters', () => {
    assert.strictEqual([...encode(0)].length, MARKER_LENGTH);
    assert.strictEqual([...encode(42)].length, MARKER_LENGTH);
    assert.strictEqual([...encode(MAX_MARKER_IDS - 1)].length, MARKER_LENGTH);
});

test('encode starts with MARKER_START (U+2060) and ends with MARKER_END (U+200B)', () => {
    for (const id of [0, 1, 42, MAX_MARKER_IDS - 1]) {
        const m = encode(id);
        assert.strictEqual(m[0], MARKER_START,
            `encode(${id})[0] must be MARKER_START (U+2060)`);
        assert.strictEqual(m[MARKER_LENGTH - 1], MARKER_END,
            `encode(${id})[${MARKER_LENGTH - 1}] must be MARKER_END (U+200B)`);
    }
});

test('encode is deterministic: repeated calls on the same id yield the same string', () => {
    for (const id of [0, 1, 99, 512, MAX_MARKER_IDS - 1]) {
        assert.strictEqual(encode(id), encode(id),
            `encode(${id}) must be stable`);
    }
});

test('all body characters are from MARKER_ALPHABET (0–3)', () => {
    const sentinelSet = new Set([...SENTINEL_CODEPOINTS]);
    for (const id of [0, 1, 42, 255, 1023, MAX_MARKER_IDS - 1]) {
        const marker = encode(id);
        for (let i = 1; i <= MARKER_BODY_LENGTH; i++) {
            assert.ok(sentinelSet.has(marker[i] as (typeof SENTINEL_CODEPOINTS)[number]),
                `encode(${id}): body char at position ${i} must be a SENTINEL codepoint`);
        }
    }
});

test('decode recovers the encoded id for boundary and typical values', () => {
    for (const id of [0, 1, 2, 42, 255, 1023, 65535, MAX_MARKER_IDS - 1]) {
        const recovered = decode(encode(id));
        assert.strictEqual(recovered, id,
            `decode(encode(${id})) should return ${id}, got ${recovered}`);
    }
});

test('decode recovers id from marker + message content', () => {
    const id = 12345;
    const content = '{count,plural,one{1 message}other{# messages}}';
    const marked = encode(id) + content;
    assert.strictEqual(decode(marked), id);
});

test('decode returns null for plain text with no marker', () => {
    assert.strictEqual(decode(''), null);
    assert.strictEqual(decode('Hello, world!'), null);
    assert.strictEqual(decode('{count,plural,one{1 item}other{# items}}'), null);
    assert.strictEqual(decode('No invisible chars here.'), null);
});

test('decode boundary: id=0 (all body chars are MARKER_END = U+200B)', () => {
    const marker = encode(0);
    // All 10 body positions should be U+200B (ALPHABET[0] = 0b00)
    for (let i = 1; i <= MARKER_BODY_LENGTH; i++) {
        assert.strictEqual(marker[i], MARKER_END,
            `encode(0) body position ${i} should be MARKER_END (U+200B = ALPHABET[0])`);
    }
    assert.strictEqual(decode(marker), 0);
});

test('decode boundary: id=MAX_MARKER_IDS-1 (all body chars are MARKER_START = U+2060)', () => {
    const marker = encode(MAX_MARKER_IDS - 1);
    // All 10 body positions should be U+2060 (ALPHABET[3] = 0b11)
    for (let i = 1; i <= MARKER_BODY_LENGTH; i++) {
        assert.strictEqual(marker[i], MARKER_START,
            `encode(MAX-1) body position ${i} should be MARKER_START (U+2060 = ALPHABET[3])`);
    }
    assert.strictEqual(decode(marker), MAX_MARKER_IDS - 1);
});

// ---------------------------------------------------------------------------
// PREFIX-only placement
// ---------------------------------------------------------------------------

console.log('\n-- PREFIX-only placement --');

test('marker is a strict prefix: marked = encode(id) + original', () => {
    const id = 7;
    const msg = 'Hello, world!';
    const marked = encode(id) + msg;
    assert.strictEqual(marked.slice(0, MARKER_LENGTH), encode(id),
        'first MARKER_LENGTH chars must be the marker');
    assert.strictEqual(marked.slice(MARKER_LENGTH), msg,
        'chars after the marker must be the original message');
});

test('ICU prefix is outside braces: the marker does not modify ICU brace content', () => {
    const icuMessages = [
        '{count,plural,one{# item}other{# items}}',
        '{name} logged in',
        'Balance: {amount,number,currency}',
        '{gender,select,male{He}female{She}other{They}} liked your post',
        'Hello, {name}! You have {count,plural,one{1 msg}other{# msgs}}.',
    ];
    for (const msg of icuMessages) {
        const marked = encode(0) + msg;
        // The marker is a strict prefix — the original ICU content follows unchanged
        assert.ok(marked.endsWith(msg),
            `Marked string must end with original ICU content. Msg: "${msg}"`);
        assert.strictEqual(marked.slice(MARKER_LENGTH), msg,
            `Content after marker must be the unmodified ICU string. Msg: "${msg}"`);
        // The first '{' must appear after the marker prefix (not inside the 12-char marker)
        const firstBrace = marked.indexOf('{');
        if (msg.includes('{')) {
            assert.ok(firstBrace >= MARKER_LENGTH,
                `First '{' must be at or after MARKER_LENGTH (${MARKER_LENGTH}), got ${firstBrace}. Msg: "${msg}"`);
        }
    }
});

// ---------------------------------------------------------------------------
// stripMarkers — round-trip tests
// ---------------------------------------------------------------------------

console.log('\n-- stripMarkers --');

test('ICU plural round-trip: stripMarkers(encode(id) + msg) === msg', () => {
    const icuMessages = [
        '{count,plural,one{# item}other{# items}}',
        '{name} logged in',
        'Balance: {amount,number,currency}',
        '{gender,select,male{He}female{She}other{They}} liked your post',
        'Hello, {name}! You have {count,plural,one{1 msg}other{# msgs}}.',
    ];
    for (const msg of icuMessages) {
        const marked = encode(42) + msg;
        assert.strictEqual(stripMarkers(marked), msg,
            `stripMarkers round-trip failed for: "${msg}"`);
    }
});

test('stripMarkers removes all four sentinel codepoints', () => {
    const plain = 'Hello world';
    for (const id of [0, 1, 42, MAX_MARKER_IDS - 1]) {
        const marked = encode(id) + plain;
        const stripped = stripMarkers(marked);
        assert.strictEqual(stripped, plain,
            `stripMarkers(encode(${id}) + "${plain}") should equal "${plain}"`);
    }
});

test('stripMarkers on plain text with no markers returns the string unchanged', () => {
    const plain = 'No markers here. Just ASCII text.';
    assert.strictEqual(stripMarkers(plain), plain);
});

test('stripMarkers on empty string returns empty string', () => {
    assert.strictEqual(stripMarkers(''), '');
});

test('stripMarkers: no sentinel codepoints remain after stripping', () => {
    const msg = 'some text';
    for (const id of [0, 255, MAX_MARKER_IDS - 1]) {
        const stripped = stripMarkers(encode(id) + msg);
        for (const cp of SENTINEL_CODEPOINTS) {
            assert.ok(!stripped.includes(cp),
                `Stripped string must not contain sentinel codepoint U+${cp.codePointAt(0)?.toString(16).toUpperCase()}`);
        }
    }
});

// ---------------------------------------------------------------------------
// Emoji-trailing safety
// ---------------------------------------------------------------------------

console.log('\n-- Emoji-trailing safety --');

test('MARKER_END is not U+200D (ZWJ) — trailing emojis are not joined to the marker', () => {
    assert.notStrictEqual(MARKER_END, '‍',
        'MARKER_END must not be ZWJ (U+200D); that would join it to a subsequent emoji into a ZWJ sequence');
});

test('encode: last char of marker is MARKER_END, not U+200D (ZWJ)', () => {
    for (const id of [0, 1, MAX_MARKER_IDS - 1]) {
        const m = encode(id);
        const lastChar = m[MARKER_LENGTH - 1];
        assert.notStrictEqual(lastChar, '‍',
            `encode(${id}) must not end with ZWJ (U+200D) — emoji-joining risk`);
        assert.strictEqual(lastChar, MARKER_END,
            `encode(${id}) must end with MARKER_END`);
    }
});

test('emoji safety: marker + emoji string — END sentinel before emoji, no grapheme joining', () => {
    // U+1F44D = THUMBS UP, single-codepoint emoji (not a ZWJ sequence)
    const emoji = '\u{1F44D}';
    const msg = `Great job! ${emoji}`;
    const marked = encode(5) + msg;

    // MARKER_END is at position MARKER_LENGTH-1; the message starts at MARKER_LENGTH
    assert.strictEqual(marked[MARKER_LENGTH - 1], MARKER_END,
        'char just before message content must be MARKER_END (not ZWJ)');
    assert.strictEqual(marked.slice(MARKER_LENGTH), msg,
        'message content after marker must be unchanged');

    // stripMarkers restores the original (no corruption of the emoji)
    assert.strictEqual(stripMarkers(marked), msg,
        'stripMarkers must recover the original string including emoji');
});

test('emoji safety: marker body can contain ZWJ (U+200D as ALPHABET[2]) but END is not ZWJ', () => {
    // id=2 in binary is 0b10 → body[0] = ALPHABET[2] = U+200D (ZWJ)
    // This is in the body, not at END. END is still MARKER_END (U+200B).
    const id = 2; // bits 0-1 = 0b10 → body[0] = U+200D
    const m = encode(id);
    assert.strictEqual(m[1], '‍',
        'body[0] for id=2 (0b10) should be U+200D (ZWJ = ALPHABET[2])');
    assert.strictEqual(m[MARKER_LENGTH - 1], MARKER_END,
        'END must still be MARKER_END (U+200B), not U+200D');
    assert.notStrictEqual(m[MARKER_LENGTH - 1], '‍',
        'END must not be ZWJ even when body chars contain ZWJ');
    assert.strictEqual(decode(m), id, 'decode must still work');
});

// ---------------------------------------------------------------------------
// wrapMessages — core tests
// ---------------------------------------------------------------------------

console.log('\n-- wrapMessages --');

test('wrapMessages: determinism — two calls on the same object yield identical results', () => {
    const messages = {
        auth: {
            login: { title: 'Sign In', subtitle: 'Welcome back' },
            register: { title: 'Sign Up' },
        },
        common: {
            ok: 'OK',
            cancel: 'Cancel',
        },
    };

    const r1 = wrapMessages(messages, { widgetPrefix: 'widget' });
    const r2 = wrapMessages(messages, { widgetPrefix: 'widget' });

    // Wrapped trees must be deeply identical
    assert.deepStrictEqual(r1.wrapped, r2.wrapped);

    // Registry sizes must match
    assert.strictEqual(r1.registry.size, r2.registry.size);

    // Every id must map to the same KeyRef in both registries
    for (const [id, ref] of r1.registry) {
        assert.ok(r2.registry.has(id), `id ${id} missing from second registry`);
        assert.deepStrictEqual(r2.registry.get(id), ref,
            `KeyRef for id ${id} differs between calls`);
    }
});

test('wrapMessages: every non-empty leaf string is marked (decode returns an id)', () => {
    const messages = {
        ns: { a: 'hello', b: 'world' },
    };
    const { wrapped } = wrapMessages(messages, { widgetPrefix: 'widget' });
    const ns = wrapped['ns'] as Record<string, unknown>;

    assert.ok(typeof ns['a'] === 'string' && decode(ns['a'] as string) !== null,
        'ns.a should be a marked string');
    assert.ok(typeof ns['b'] === 'string' && decode(ns['b'] as string) !== null,
        'ns.b should be a marked string');
});

test('wrapMessages: empty strings are NOT marked — they pass through as-is', () => {
    const messages = { ns: { empty: '', nonEmpty: 'hi' } };
    const { wrapped } = wrapMessages(messages, { widgetPrefix: 'widget' });
    const ns = wrapped['ns'] as Record<string, unknown>;

    assert.strictEqual(ns['empty'], '', 'empty string must not be marked');
    assert.notStrictEqual(ns['nonEmpty'], 'hi',
        'non-empty string should be marked (different from original)');
    assert.ok(typeof ns['nonEmpty'] === 'string' &&
        decode(ns['nonEmpty'] as string) !== null,
        'non-empty string must decode to a valid id');
});

test('wrapMessages: ids are assigned sequentially in pre-order (0, 1, 2, ...)', () => {
    const messages = { ns: { a: 'A', b: 'B', c: 'C' } };
    const { wrapped, registry } = wrapMessages(messages, { widgetPrefix: 'widget' });
    const ns = wrapped['ns'] as Record<string, unknown>;

    assert.strictEqual(registry.size, 3);
    assert.strictEqual(decode(ns['a'] as string), 0);
    assert.strictEqual(decode(ns['b'] as string), 1);
    assert.strictEqual(decode(ns['c'] as string), 2);
});

test('wrapMessages: namespace derivation for regular namespaces', () => {
    const messages = {
        auth: { login: { title: 'Sign In' } },
        common: { ok: 'OK' },
    };
    const { registry } = wrapMessages(messages, { widgetPrefix: 'widget' });

    // Pre-order walk: auth.login.title → id=0, common.ok → id=1
    const ref0 = registry.get(0);
    assert.ok(ref0, 'id 0 must exist in registry');
    assert.strictEqual(ref0.namespace, 'auth',
        'auth.login.title should have namespace "auth"');
    assert.strictEqual(ref0.dotKey, 'login.title',
        'auth.login.title should have dotKey "login.title"');

    const ref1 = registry.get(1);
    assert.ok(ref1, 'id 1 must exist in registry');
    assert.strictEqual(ref1.namespace, 'common',
        'common.ok should have namespace "common"');
    assert.strictEqual(ref1.dotKey, 'ok',
        'common.ok should have dotKey "ok"');
});

test('wrapMessages: namespace derivation for widget namespaces', () => {
    const messages = {
        widget: {
            'active-booking': {
                label: 'Book Now',
                cancel: 'Cancel booking',
            },
        },
    };
    const { registry } = wrapMessages(messages, { widgetPrefix: 'widget' });

    assert.strictEqual(registry.size, 2);

    // widget.active-booking.label → namespace="widget.active-booking", dotKey="label"
    const ref0 = registry.get(0);
    assert.ok(ref0, 'id 0 must exist in registry');
    assert.strictEqual(ref0.namespace, 'widget.active-booking');
    assert.strictEqual(ref0.dotKey, 'label');

    // widget.active-booking.cancel → namespace="widget.active-booking", dotKey="cancel"
    const ref1 = registry.get(1);
    assert.ok(ref1, 'id 1 must exist in registry');
    assert.strictEqual(ref1.namespace, 'widget.active-booking');
    assert.strictEqual(ref1.dotKey, 'cancel');
});

test('wrapMessages: nested widget key dotKey includes full remaining path', () => {
    const messages = {
        widget: {
            booking: {
                details: {
                    status: 'Active',
                },
            },
        },
    };
    const { registry } = wrapMessages(messages, { widgetPrefix: 'widget' });
    const ref = registry.get(0);
    assert.ok(ref, 'id 0 must exist');
    assert.strictEqual(ref.namespace, 'widget.booking');
    assert.strictEqual(ref.dotKey, 'details.status');
});

test('wrapMessages: ICU message is preserved — stripMarkers recovers the original', () => {
    const icu = '{count,plural,one{# item}other{# items}}';
    const messages = { ns: { key: icu } };
    const { wrapped } = wrapMessages(messages, { widgetPrefix: 'widget' });
    const ns = wrapped['ns'] as Record<string, unknown>;
    const markedIcu = ns['key'] as string;

    assert.strictEqual(stripMarkers(markedIcu), icu,
        'stripMarkers must recover the original ICU string');
    assert.ok(markedIcu.endsWith(icu),
        'marked string must end with the unmodified ICU string');
});

test('wrapMessages: non-string, non-object leaves pass through unchanged', () => {
    const messages: Record<string, unknown> = {
        ns: {
            str: 'hello',
        },
    };
    // Add non-string values
    (messages['ns'] as Record<string, unknown>)['num'] = 42;
    (messages['ns'] as Record<string, unknown>)['bool'] = true;
    (messages['ns'] as Record<string, unknown>)['nul'] = null;
    (messages['ns'] as Record<string, unknown>)['arr'] = ['x', 'y'];

    const { wrapped, registry } = wrapMessages(messages, { widgetPrefix: 'widget' });
    const ns = wrapped['ns'] as Record<string, unknown>;

    // Only str should be marked
    assert.strictEqual(registry.size, 1);
    assert.strictEqual(ns['num'], 42);
    assert.strictEqual(ns['bool'], true);
    assert.strictEqual(ns['nul'], null);
    assert.deepStrictEqual(ns['arr'], ['x', 'y']);
    assert.ok(typeof ns['str'] === 'string' && decode(ns['str']) === 0);
});

test('wrapMessages: mixed namespace and widget keys in same messages object', () => {
    const messages = {
        auth: { login: 'Log in' },
        widget: {
            sidebar: { title: 'Navigation' },
        },
        common: { save: 'Save' },
    };
    const { registry } = wrapMessages(messages, { widgetPrefix: 'widget' });

    assert.strictEqual(registry.size, 3);

    // id 0: auth.login
    const ref0 = registry.get(0);
    assert.ok(ref0);
    assert.strictEqual(ref0.namespace, 'auth');
    assert.strictEqual(ref0.dotKey, 'login');

    // id 1: widget.sidebar.title
    const ref1 = registry.get(1);
    assert.ok(ref1);
    assert.strictEqual(ref1.namespace, 'widget.sidebar');
    assert.strictEqual(ref1.dotKey, 'title');

    // id 2: common.save
    const ref2 = registry.get(2);
    assert.ok(ref2);
    assert.strictEqual(ref2.namespace, 'common');
    assert.strictEqual(ref2.dotKey, 'save');
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

console.log('\n-- Constants sanity --');

test('MARKER_LENGTH === 1 + MARKER_BODY_LENGTH + 1', () => {
    assert.strictEqual(MARKER_LENGTH, 1 + MARKER_BODY_LENGTH + 1);
});

test('SENTINEL_CODEPOINTS contains all four required codepoints', () => {
    const set = new Set(SENTINEL_CODEPOINTS);
    assert.ok(set.has('​'), 'must include U+200B (ZERO-WIDTH SPACE)');
    assert.ok(set.has('‌'), 'must include U+200C (ZERO-WIDTH NON-JOINER)');
    assert.ok(set.has('‍'), 'must include U+200D (ZERO-WIDTH JOINER)');
    assert.ok(set.has('⁠'), 'must include U+2060 (WORD JOINER)');
});

test('MARKER_START is U+2060 (WORD JOINER)', () => {
    assert.strictEqual(MARKER_START.codePointAt(0), 0x2060);
});

test('MARKER_END is U+200B (ZERO-WIDTH SPACE) — not ZWJ (U+200D)', () => {
    assert.strictEqual(MARKER_END.codePointAt(0), 0x200B);
    assert.notStrictEqual(MARKER_END.codePointAt(0), 0x200D);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
if (failed > 0) {
    console.error(`${failed} test(s) FAILED, ${passed} passed.`);
    process.exit(1);
} else {
    console.log(`All ${passed} tests PASSED.`);
}
