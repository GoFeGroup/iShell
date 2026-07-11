const ASTERISK = 0x2a;
const ZDLE = 0x18;
const HEX_HEADER = 0x42;
const CARRIAGE_RETURN = 0x0d;
const CR_8BIT = 0x8d;
const LINE_FEED = 0x0a;
const XON = 0x11;
const ZMODEM_HEX_HEADER_LENGTH = 20;

function isHexOctet(octet) {
    return (octet >= 0x30 && octet <= 0x39)
        || (octet >= 0x41 && octet <= 0x46)
        || (octet >= 0x61 && octet <= 0x66);
}

const headerPrefixMatches = (bytes, start) => bytes[start] === ASTERISK
    && bytes[start + 1] === ASTERISK
    && bytes[start + 2] === ZDLE
    && bytes[start + 3] === HEX_HEADER;

// `available` is however many bytes remain in `bytes` from `start` onward.
// With available >= ZMODEM_HEX_HEADER_LENGTH this fully validates a complete
// header (hex body, then CR(8bit)/LF); with fewer bytes it only validates
// what's present so far, for streaming/partial-chunk callers.
const isHeaderByteValid = (bytes, start, available) => {
    for (let i = 4; i < Math.min(18, available); i++) {
        if (!isHexOctet(bytes[start + i])) return false;
    }
    if (available > 18 && bytes[start + 18] !== CARRIAGE_RETURN && bytes[start + 18] !== CR_8BIT) return false;
    return available <= 19 || bytes[start + 19] === LINE_FEED;
};

// zmodem.js detects a complete initial hex header, then still forwards that
// same input to to_terminal(). Remove only that confirmed frame so ordinary
// terminal output (including the next shell prompt) remains visible.
export function stripDetectedZmodemHeader(octets) {
    let end = octets.length;
    if (octets[end - 1] === XON) end -= 1;

    const start = end - ZMODEM_HEX_HEADER_LENGTH;
    if (start < 0 || octets[end - 1] !== LINE_FEED) return octets;
    if (octets[end - 2] !== CARRIAGE_RETURN && octets[end - 2] !== CR_8BIT) return octets;
    if (octets[start] !== ASTERISK || octets[start + 1] !== ASTERISK
        || octets[start + 2] !== ZDLE || octets[start + 3] !== HEX_HEADER) {
        return octets;
    }
    for (let i = start + 4; i < end - 2; i++) {
        if (!isHexOctet(octets[i])) return octets;
    }
    return octets.slice(0, start);
}

// zmodem.js sends undecided input to `to_terminal()` while it accumulates a
// detection header. SSH reads may split that header across events, so hiding a
// header only after `on_detect` is too late: its leading `**\x18B000...` bytes
// have already reached xterm. This filter retains only a possible header
// prefix, emits ordinary output immediately, and drops a complete header even
// when it spans multiple input events.
export function createZmodemHeaderFilter() {
    let pending = new Uint8Array();
    // Set right after a header is consumed at the end of a chunk, so a lone
    // trailing XON that arrives at the start of the *next* chunk is still
    // recognized as part of the header rather than rendered as text.
    let expectTrailingXon = false;

    return {
        consume(octets) {
            const bytes = new Uint8Array(pending.length + octets.length);
            bytes.set(pending);
            bytes.set(octets, pending.length);
            pending = new Uint8Array();

            const output = [];
            let pos = 0;
            if (expectTrailingXon) {
                expectTrailingXon = false;
                if (bytes.length > 0 && bytes[0] === XON) pos = 1;
            }
            while (pos < bytes.length) {
                const available = bytes.length - pos;
                if (bytes[pos] !== ASTERISK) {
                    output.push(bytes[pos++]);
                    continue;
                }
                if (available < 4) {
                    // Retain only a real prefix; a lone '*' is normal output.
                    const prefix = [ASTERISK, ASTERISK, ZDLE, HEX_HEADER];
                    let matches = true;
                    for (let i = 0; i < available; i++) matches &&= bytes[pos + i] === prefix[i];
                    if (matches) break;
                    output.push(bytes[pos++]);
                    continue;
                }
                if (!headerPrefixMatches(bytes, pos) || !isHeaderByteValid(bytes, pos, available)) {
                    output.push(bytes[pos++]);
                    continue;
                }
                if (available < ZMODEM_HEX_HEADER_LENGTH) break;

                // Confirmed ZRINIT/ZRQINIT hex header: never render it.
                pos += ZMODEM_HEX_HEADER_LENGTH;
                // The header is optionally followed by a single XON byte
                // (zmodem.js's zsentry.js still forwards it to to_terminal
                // along with the rest of the detected chunk); swallow it too
                // instead of printing a stray control character.
                if (pos < bytes.length) {
                    if (bytes[pos] === XON) pos += 1;
                } else {
                    expectTrailingXon = true;
                }
            }

            pending = bytes.slice(pos);
            return new Uint8Array(output);
        },
        reset() {
            pending = new Uint8Array();
            expectTrailingXon = false;
        },
    };
}

// zmodem.js's Sentry only recognizes a new session if the bytes handed to a
// single consume() call, minus the detected header (and, if it's the only
// byte left, a trailing XON), leave its internal buffer completely empty —
// see zsentry.js's _parse(): "This logic depends on the sender only sending
// one initial header." A real SSH/PTY read can bundle the header together
// with whatever the peer wrote right after it (more likely with larger
// transfers, e.g. multiple files), which silently defeats detection: no
// on_detect ever fires, we never reply with ZRINIT, and the raw header text
// gets forwarded to to_terminal instead.
//
// Split a chunk at the first complete header's boundary (including its
// optional trailing XON) so callers can feed the library the header alone
// first — satisfying its "nothing else in this call" assumption and letting
// detection succeed — then feed the remaining bytes in a follow-up call,
// which by then lands on the now-established session and is unaffected by
// this limitation.
//
// Returns { header, rest } when there are bytes left over after a complete
// header, or null when no split is needed (no full header found yet, or the
// header/header+XON already consumes the whole chunk).
export function splitLeadingZmodemHeader(bytes) {
    for (let start = 0; start + ZMODEM_HEX_HEADER_LENGTH <= bytes.length; start++) {
        if (bytes[start] !== ASTERISK) continue;
        const available = bytes.length - start;
        if (!headerPrefixMatches(bytes, start) || !isHeaderByteValid(bytes, start, available)) continue;

        let end = start + ZMODEM_HEX_HEADER_LENGTH;
        if (bytes[end] === XON) end += 1;

        if (end >= bytes.length) return null;
        return { header: bytes.slice(0, end), rest: bytes.slice(end) };
    }
    return null;
}
