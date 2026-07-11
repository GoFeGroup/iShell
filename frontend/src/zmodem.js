import Zmodem from 'zmodem.js';
import { sendInputBytes, openFilesForZmodem, saveZmodemFile } from './api.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';
import { createZmodemHeaderFilter, splitLeadingZmodemHeader } from './zmodem-protocol.mjs';

function octetsToBase64(octets) {
    let binary = '';
    const step = 8192;
    for (let i = 0; i < octets.length; i += step) {
        const end = Math.min(i + step, octets.length);
        for (let j = i; j < end; j++) {
            binary += String.fromCharCode(octets[j]);
        }
    }
    return btoa(binary);
}

function uint8ArrayToBase64(bytes) {
    let binary = '';
    const step = 8192;
    for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
    }
    return btoa(binary);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const ZMODEM_ABORT_DRAIN_MS = 2500;
const UPLOAD_CHUNK_SIZE = 8192;
const UPLOAD_YIELD_EVERY_CHUNKS = 16;
const CAN = 0x18;
const BS = 0x08;
const ETX = 0x03;
const USER_CANCEL_OCTETS = [
    CAN, CAN, CAN, CAN, CAN, CAN, CAN, CAN,
    BS, BS, BS, BS, BS, BS, BS, BS, BS, BS,
    ETX,
];

// Creates a Zmodem-aware data consumer for a terminal connection.
// Returns { consume(b64), abort() }.
// onActive(bool) is called when a Zmodem session starts (true) or ends (false).
export function createZmodemSentry(connID, term, onActive) {
    let senderQueue = Promise.resolve();
    let currentSession = null;
    // Only invalidate queued protocol bytes after an explicit cancellation.
    // A normal session transition must not discard its final ZFIN/ZRINIT
    // handshake while the Wails IPC queue is still draining.
    let cancelEpoch = 0;
    let forceSender = false;
    let drainTerminalUntil = 0;
    let sessionActive = false;
    const terminalOutput = createZmodemHeaderFilter();

    const isDrainingTerminal = () => Date.now() < drainTerminalUntil;
    const drainTerminalOutput = () => {
        drainTerminalUntil = Math.max(drainTerminalUntil, Date.now() + ZMODEM_ABORT_DRAIN_MS);
        terminalOutput.reset();
    };

    const queuePeerBytes = (octets, { force = false } = {}) => {
        const epoch = cancelEpoch;
        const b64 = octetsToBase64(octets);
        senderQueue = senderQueue
            .then(() => {
                if (!force && epoch !== cancelEpoch) return;
                return sendInputBytes(connID, b64);
            })
            .catch(e => {
                console.error('zmodem sender failed:', e);
                showToast(t('zmodem.sendFailed'), 3000);
            });
    };

    const finishSession = (session) => {
        if (session && currentSession !== session) return;
        currentSession = null;
        sessionActive = false;
        // Clear any stuck partial-header state so the shell's next prompt
        // (or any other post-transfer output) is never swallowed/mangled.
        terminalOutput.reset();
        onActive?.(false);
    };

    const abortSession = () => {
        const s = currentSession;
        drainTerminalOutput();
        if (s && !s.has_ended()) {
            forceSender = true;
            try { s.abort(); } catch {}
            finally { forceSender = false; }
        }
        cancelEpoch += 1;
        queuePeerBytes(USER_CANCEL_OCTETS, { force: true });
        finishSession(s);
    };

    let sentry;
    try {
        sentry = new Zmodem.Sentry({
            to_terminal(octets) {
                if (isDrainingTerminal()) return;
                // Once a session is confirmed active, anything the library still
                // forwards here is zmodem-internal noise (frame-misalignment
                // "garbage" between files, e.g. before a ZFILE header for the
                // next file) — never legitimate shell output. Drop it outright
                // instead of running it through the header pattern filter.
                if (sessionActive) return;
                const output = terminalOutput.consume(octets);
                if (output.length > 0) term.write(new Uint8Array(output));
            },
            sender(octets) {
                queuePeerBytes(octets, { force: forceSender });
            },
            on_retract() {
                finishSession();
            },
            on_detect(detection) {
                const zsession = detection.confirm();
                drainTerminalUntil = 0;
                currentSession = zsession;
                onActive?.(true);
                // zsentry.js forwards the same chunk that completed detection to
                // to_terminal() synchronously, in this same tick (it still needs
                // the streaming header filter, since that chunk may legitimately
                // contain preceding shell text sharing the read with the ZRQINIT/
                // ZRINIT header). Only bytes forwarded on a *later* tick -- i.e.
                // "garbage" events during an already-active session -- should be
                // hard-muted, so defer flipping the gate by one microtask; this
                // always resolves before the next terminal:data event can arrive.
                Promise.resolve().then(() => {
                    if (currentSession === zsession) sessionActive = true;
                });
                // The protocol's session_end event is authoritative. Do not
                // keep terminal input blocked while file persistence finishes.
                zsession.on('session_end', () => finishSession(zsession));
                runSession(connID, zsession)
                    .catch(e => {
                        const msg = String(e?.message ?? e);
                        if (!msg.includes('aborted') && !msg.includes('peer_aborted') && !msg.includes('timeout')) {
                            console.error('zmodem session error:', e);
                            showToast(t('zmodem.error', { msg }), 3000);
                        }
                    })
                    .finally(() => {
                        finishSession(zsession);
                    });
            },
        });
    } catch (e) {
        console.error('zmodem sentry init failed:', e);
        // Fall back to plain terminal writer
        return {
            consume: (b64) => {
                try { term.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); } catch {}
            },
            abort: () => {},
        };
    }

    const consume = (b64) => {
        let bytes;
        try {
            bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        } catch {
            return;
        }
        try {
            // zmodem.js's Sentry only detects a new session if a single
            // consume() call contains nothing but the header (plus an
            // optional trailing XON) — see splitLeadingZmodemHeader's doc
            // comment. A real SSH read can bundle the header with whatever
            // the peer wrote right after it, so split it off first when
            // there's no session yet; once one exists, per-session parsing
            // has no such restriction and extra bytes are handled as-is.
            if (!currentSession) {
                const split = splitLeadingZmodemHeader(bytes);
                if (split) {
                    sentry.consume(split.header);
                    if (split.rest.length) sentry.consume(split.rest);
                } else {
                    sentry.consume(bytes);
                }
            } else {
                sentry.consume(bytes);
            }
        } catch (e) {
            const msg = String(e?.message ?? e);
            if (!msg.includes('aborted') && !msg.includes('peer_aborted')) {
                console.error('zmodem consume error:', e);
            }
            // Abort session on consume error so the terminal unfreezes
            abortSession();
            if (!isDrainingTerminal()) {
                try { term.write(bytes); } catch {}
            }
        }
    };

    return { consume, abort: abortSession };
}

async function runSession(connID, zsession) {
    if (zsession.type === 'receive') {
        await receiveFiles(zsession);
    } else {
        await sendFiles(connID, zsession);
    }
}

// sz on server → we receive files
async function receiveFiles(zsession) {
    showToast(t('zmodem.receiving'));

    const transferPromises = [];

    zsession.on('offer', offer => {
        const name = offer.get_details().name;
        const p = offer.accept().then(async payloads => {
            const totalLen = payloads.reduce((sum, c) => sum + c.length, 0);
            const content = new Uint8Array(totalLen);
            let off = 0;
            for (const chunk of payloads) {
                content.set(chunk, off);
                off += chunk.length;
            }
            try {
                const savedPath = await saveZmodemFile(name, uint8ArrayToBase64(content));
                showToast(t('zmodem.downloaded', { name, path: savedPath }), 4000);
            } catch (e) {
                showToast(t('zmodem.saveFailed', { name, e }), 3000);
                console.error('zmodem saveZmodemFile:', e);
            }
        });
        transferPromises.push(p);
    });

    // Wait for session to end, with a 2-minute safety timeout.
    // Register this before start(): a fast local/SSH peer may complete the
    // final handshake before a later listener could observe it.
    const SESSION_TIMEOUT_MS = 120_000;
    const sessionEnd = new Promise(resolve => zsession.on('session_end', resolve));
    let timeoutID;
    const timeout = new Promise((_, reject) => {
        timeoutID = setTimeout(() => reject(new Error('timeout')), SESSION_TIMEOUT_MS);
    });

    // start() sends ZRINIT to the server, initiating the transfer handshake.
    zsession.start();

    try {
        await Promise.race([sessionEnd, timeout]);
    } catch (e) {
        try { zsession.abort(); } catch {}
        if (String(e?.message).includes('timeout')) {
            showToast(t('zmodem.timedOut'), 3000);
        }
    } finally {
        clearTimeout(timeoutID);
    }

    // Wait for in-flight file saves, but don't block forever if accept() hung.
    await Promise.race([
        Promise.allSettled(transferPromises),
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
}

// rz on server → we send files
async function sendFiles(connID, zsession) {
    showToast(t('zmodem.selectFiles'));

    let files;
    try {
        files = await openFilesForZmodem();
    } catch (e) {
        try { zsession.abort(); } catch {}
        showToast(t('zmodem.uploadCancelledErr', { e }), 3000);
        return;
    }

    if (!files || files.length === 0) {
        try { zsession.abort(); } catch {}
        showToast(t('zmodem.uploadCancelled'), 2000);
        return;
    }

    showToast(t('zmodem.sending', { n: files.length }));

    for (const file of files) {
        if (zsession.aborted?.()) throw new Zmodem.Error('aborted');
        const bytes = Uint8Array.from(atob(file.content), c => c.charCodeAt(0));

        const xfer = await zsession.send_offer({ name: file.name, size: file.size });
        if (zsession.aborted?.()) throw new Zmodem.Error('aborted');
        if (xfer === undefined) continue; // remote skipped this file

        for (let i = 0, chunks = 0; i < bytes.length; i += UPLOAD_CHUNK_SIZE, chunks++) {
            if (zsession.aborted?.()) throw new Zmodem.Error('aborted');
            xfer.send(bytes.subarray(i, Math.min(i + UPLOAD_CHUNK_SIZE, bytes.length)));
            if (chunks > 0 && chunks % UPLOAD_YIELD_EVERY_CHUNKS === 0) {
                await sleep(0);
            }
        }
        if (zsession.aborted?.()) throw new Zmodem.Error('aborted');
        await xfer.end();
    }

    if (zsession.aborted?.()) throw new Zmodem.Error('aborted');
    await zsession.close();
    showToast(t('zmodem.uploadComplete'), 3000);
}
