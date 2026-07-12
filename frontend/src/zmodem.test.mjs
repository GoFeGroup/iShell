import assert from 'node:assert/strict';
import test from 'node:test';
import Zmodem from 'zmodem.js';

// zmodem.js transitively imports i18n.js/toast.js, which touch `document`
// at module load time in a browser (Node already provides a `navigator`
// global). Stub the minimum needed so the import succeeds under plain Node.
globalThis.document = {
    getElementById: () => null,
    documentElement: { setAttribute: () => {} },
};
globalThis.window = { go: { backend: { App: { SendInputBytes: async () => {} } } } };

const { createZmodemSentry } = await import('./zmodem.js');

const encoder = new TextEncoder();
// A real ZRQINIT header as sent by lrzsz (the near-universal Linux sz/rz),
// which terminates hex headers with 0x8a rather than the spec's plain LF
// (0x0a) — the zmodem.js library's own parser checks for this explicitly.
// ZRQINIT's CRC16 over an all-zero payload is itself zero, so the hex body
// really is fourteen literal '0' characters: this *is* the exact byte
// sequence behind the "**B00000000000000" the user sees on screen (ZDLE and
// CR don't render), not a corrupted or synthetic variant.
const HEADER = new Uint8Array([
    ...encoder.encode('**\x18B'),
    ...encoder.encode('0'.repeat(14)),
    0x0d, 0x8a,
]);

function toBase64(bytes) {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return Buffer.from(binary, 'binary').toString('base64');
}

function containsRawHeaderPrefix(bytes) {
    const text = Buffer.from(bytes).toString('latin1');
    return text.includes('**\x18B');
}

function containsRzTrigger(bytes) {
    const text = Buffer.from(bytes).toString('latin1');
    return text.includes('rz\r');
}

function createHarness() {
    const writes = [];
    const sent = [];
    const active = [];
    const term = { write: bytes => writes.push(Array.from(bytes)) };
    const sendBytes = async (_connID, b64) => {
        sent.push(Array.from(Buffer.from(b64, 'base64')));
    };
    const sentry = createZmodemSentry('test-conn', term, value => active.push(value), sendBytes);
    return { sentry, writes, sent, active };
}

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

test('does not write the raw ZMODEM header to the terminal when detection completes', async () => {
    const writes = [];
    const term = { write: (bytes) => writes.push(Array.from(bytes)) };
    let active = null;
    const sentry = createZmodemSentry('test-conn', term, (v) => { active = v; });

    sentry.consume(toBase64(HEADER));

    assert.equal(active, true, 'expected a Zmodem session to be detected');
    for (const w of writes) {
        assert.ok(!containsRawHeaderPrefix(w), `raw header bytes leaked to term.write: ${JSON.stringify(w)}`);
    }

    sentry.abort();
});

test('does not write lrzsz\'s "rz\\r" autostart hint when it precedes the header', async () => {
    const writes = [];
    const term = { write: (bytes) => writes.push(Array.from(bytes)) };
    let active = null;
    const sentry = createZmodemSentry('test-conn', term, (v) => { active = v; });

    const chunk = new Uint8Array([0x72, 0x7a, 0x0d, ...HEADER]);
    sentry.consume(toBase64(chunk));

    assert.equal(active, true, 'expected a Zmodem session to be detected');
    for (const w of writes) {
        assert.ok(!containsRawHeaderPrefix(w), `raw header bytes leaked to term.write: ${JSON.stringify(w)}`);
        assert.ok(!containsRzTrigger(w), `"rz\\r" leaked to term.write: ${JSON.stringify(w)}`);
    }

    sentry.abort();
});

test('does not write the raw ZMODEM header when it shares a chunk with trailing bytes', async () => {
    const writes = [];
    const term = { write: (bytes) => writes.push(Array.from(bytes)) };
    let active = null;
    const sentry = createZmodemSentry('test-conn', term, (v) => { active = v; });

    const extra = encoder.encode('trailing protocol bytes');
    const chunk = new Uint8Array([...HEADER, ...extra]);

    sentry.consume(toBase64(chunk));

    assert.equal(active, true, 'expected a Zmodem session to be detected');
    for (const w of writes) {
        assert.ok(!containsRawHeaderPrefix(w), `raw header bytes leaked to term.write: ${JSON.stringify(w)}`);
    }

    sentry.abort();
});

test('Ctrl+C abort sends one cancel sequence and immediately releases terminal input', async () => {
    const { sentry, sent, active } = createHarness();
    sentry.consume(toBase64(HEADER));
    await flushPromises();

    sentry.abort();
    await flushPromises();

    assert.equal(active.at(-1), false);
    const cancelWrites = sent.filter(bytes => bytes.filter(b => b === 0x18).length >= 5);
    assert.equal(cancelWrites.length, 1, `expected one cancel write, got ${JSON.stringify(sent)}`);
    assert.deepEqual(cancelWrites[0], [
        0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18,
        0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
        0x03,
    ]);
    await new Promise(resolve => setTimeout(resolve, 175));
    assert.deepEqual(sent.at(-1), [0x03]);
});

test('abort drain hides protocol noise but later shell output is visible', () => {
    const { sentry, writes } = createHarness();
    const originalNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    try {
        sentry.consume(toBase64(HEADER));
        sentry.abort();
        sentry.consume(toBase64(new Uint8Array([0x18, 0x18, 0x00, 0xff])));
        assert.equal(writes.length, 0);

        now += 8_001;
        sentry.consume(toBase64(encoder.encode('$ ')));
        assert.deepEqual(writes.at(-1), Array.from(encoder.encode('$ ')));
    } finally {
        Date.now = originalNow;
    }
});

test('abort drain does not treat a large binary chunk with weak ANSI bytes as terminal output', () => {
    const { sentry, writes } = createHarness();
    sentry.consume(toBase64(HEADER));
    sentry.abort();

    const noise = new Uint8Array(16 * 1024);
    noise.set(encoder.encode(' properly'));
    noise[100] = 0x1b;
    noise[101] = 0x5b;
    noise[102] = 0x33;
    noise[103] = 0x31;
    noise[104] = 0x6d;
    sentry.consume(toBase64(noise));

    assert.equal(writes.length, 0);
});

test('abort drain discards a binary prefix sharing a chunk with the shell prompt', async () => {
    const { sentry, writes } = createHarness();
    sentry.consume(toBase64(HEADER));
    sentry.abort();

    const noise = new Uint8Array(16 * 1024);
    noise.fill(0x7f);
    const prompt = encoder.encode('\x1b[?2004h\x1b[01;32mroot@host\x1b[00m:# ');
    const mixed = new Uint8Array(noise.length + prompt.length);
    mixed.set(noise);
    mixed.set(prompt, noise.length);
    sentry.consume(toBase64(mixed));
    await flushPromises();

    assert.deepEqual(writes.at(-1), Array.from(prompt));
});

test('abort drain stops when the remote shell prompt arrives', async () => {
    const { sentry, writes } = createHarness();
    sentry.consume(toBase64(HEADER));
    sentry.abort();

    const prompt = encoder.encode('\x1b[?2004h\x1b[01;32mroot@host\x1b[00m:# ');
    sentry.consume(toBase64(prompt));
    await flushPromises();

    assert.deepEqual(writes.at(-1), Array.from(prompt));
});

test('receiver completes ZFIN/OO handshake and releases terminal input', async () => {
    const { sentry, writes, sent, active } = createHarness();
    sentry.consume(toBase64(HEADER));
    await flushPromises();

    const zfin = new Uint8Array(Zmodem.Header.build('ZFIN').to_hex());
    sentry.consume(toBase64(zfin));
    sentry.consume(toBase64(new Uint8Array([0x4f, 0x4f, ...encoder.encode('$ ')])));
    await flushPromises();

    assert.equal(active.at(-1), false);
    assert.ok(sent.some(bytes => containsRawHeaderPrefix(bytes)), 'expected a ZFIN response to the peer');
    assert.deepEqual(writes.at(-1), Array.from(encoder.encode('$ ')));
});
test('receiver tolerates a peer that omits OO and prints the shell prompt after ZFIN', async () => {
    const { sentry, writes, active } = createHarness();
    sentry.consume(toBase64(HEADER));

    const zfin = new Uint8Array(Zmodem.Header.build('ZFIN').to_hex());
    sentry.consume(toBase64(zfin));
    const prompt = encoder.encode('\x1b[01;32mroot@host\x1b[00m:# ');
    sentry.consume(toBase64(prompt));
    await flushPromises();

    assert.equal(active.at(-1), false);
    assert.deepEqual(writes.at(-1), Array.from(prompt));
});