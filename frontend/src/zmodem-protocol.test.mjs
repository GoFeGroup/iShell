import assert from 'node:assert/strict';
import test from 'node:test';
import { createZmodemHeaderFilter, splitLeadingZmodemHeader, stripDetectedZmodemHeader } from './zmodem-protocol.mjs';

const encoder = new TextEncoder();
const header = new Uint8Array([
    ...encoder.encode('**\x18B'),
    ...encoder.encode('0'.repeat(14)),
    0x0d, 0x0a,
]);

test('removes a detected ZMODEM hex header while preserving preceding output', () => {
    const prefix = encoder.encode('sending file...\r\n');
    const input = new Uint8Array([...prefix, ...header]);

    assert.deepEqual(stripDetectedZmodemHeader(input), prefix);
});

test('removes the optional trailing XON with a detected ZMODEM header', () => {
    const input = new Uint8Array([...header, 0x11]);

    assert.deepEqual(stripDetectedZmodemHeader(input), new Uint8Array());
});

test('does not remove incomplete or non-protocol terminal output', () => {
    const incomplete = encoder.encode('**\x18B00000000000000\r');
    const normal = encoder.encode('**B00000000000000\r\n$ ');

    assert.equal(stripDetectedZmodemHeader(incomplete), incomplete);
    assert.equal(stripDetectedZmodemHeader(normal), normal);
});

test('filters a ZMODEM header split across terminal output events', () => {
    const filter = createZmodemHeaderFilter();
    const first = header.slice(0, 9);
    const second = new Uint8Array([...header.slice(9), ...encoder.encode('$ ')]);

    assert.deepEqual(filter.consume(first), new Uint8Array());
    assert.deepEqual(filter.consume(second), encoder.encode('$ '));
});

test('preserves normal output around a split header', () => {
    const filter = createZmodemHeaderFilter();

    assert.deepEqual(filter.consume(encoder.encode('before ')), encoder.encode('before '));
    assert.deepEqual(filter.consume(header.slice(0, 4)), new Uint8Array());
    assert.deepEqual(filter.consume(new Uint8Array([...header.slice(4), ...encoder.encode('after')])), encoder.encode('after'));
});

test('swallows a trailing XON in the same chunk as the header', () => {
    const filter = createZmodemHeaderFilter();
    const input = new Uint8Array([...header, 0x11, ...encoder.encode('$ ')]);

    assert.deepEqual(filter.consume(input), encoder.encode('$ '));
});

test('swallows a trailing XON that arrives in the next chunk', () => {
    const filter = createZmodemHeaderFilter();

    assert.deepEqual(filter.consume(header), new Uint8Array());
    assert.deepEqual(filter.consume(new Uint8Array([0x11, ...encoder.encode('$ ')])), encoder.encode('$ '));
});

test('splits a header followed by extra bytes in the same chunk', () => {
    const extra = encoder.encode('some more protocol noise');
    const input = new Uint8Array([...header, ...extra]);

    assert.deepEqual(splitLeadingZmodemHeader(input), { header, rest: extra });
});

test('does not split when the header fills the whole buffer', () => {
    assert.equal(splitLeadingZmodemHeader(header), null);
});

test('does not split when header + trailing XON fill the whole buffer', () => {
    const input = new Uint8Array([...header, 0x11]);

    assert.equal(splitLeadingZmodemHeader(input), null);
});

test('splits after a trailing XON when more bytes follow', () => {
    const extra = encoder.encode('more');
    const input = new Uint8Array([...header, 0x11, ...extra]);

    assert.deepEqual(splitLeadingZmodemHeader(input), {
        header: new Uint8Array([...header, 0x11]),
        rest: extra,
    });
});

test('returns null when there is no header at all', () => {
    const normal = encoder.encode('**B00000000000000\r\n$ ');

    assert.equal(splitLeadingZmodemHeader(normal), null);
});

test('returns null for an incomplete header still waiting on CRLF', () => {
    const incomplete = encoder.encode('**\x18B00000000000000\r');

    assert.equal(splitLeadingZmodemHeader(incomplete), null);
});

test('splits at the first header when leading shell text precedes it', () => {
    const prefix = encoder.encode('sending file...\r\n');
    const extra = encoder.encode('extra');
    const input = new Uint8Array([...prefix, ...header, ...extra]);

    assert.deepEqual(splitLeadingZmodemHeader(input), {
        header: new Uint8Array([...prefix, ...header]),
        rest: extra,
    });
});
