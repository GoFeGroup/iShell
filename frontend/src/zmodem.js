import Zmodem from 'zmodem.js';
import {
    sendInputBytes,
    pickFilesForZmodem, openZmodemUploadFile, readZmodemFileChunk, closeZmodemUploadFile,
    openZmodemFile, writeZmodemFileChunk, closeZmodemFile, abortZmodemFile,
} from './api.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';
import { createZmodemHeaderFilter, splitLeadingZmodemHeader } from './zmodem-protocol.mjs';
import { showZmodemProgress, updateZmodemProgress, hideZmodemProgress } from './zmodem-progress.js';

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

// Encoding a whole received file in one synchronous pass blocks the JS main
// thread for the duration — for a large download that stalls everything
// (keyboard unblock, progress-bar hide, xterm even redrawing the shell
// prompt the peer already sent) until the encode finishes, well after the
// wire transfer itself is done. Yield periodically, matching the send
// path's existing chunk-send loop below.

function findOctetSequence(octets, sequence) {
    outer: for (let i = 0; i <= octets.length - sequence.length; i++) {
        for (let j = 0; j < sequence.length; j++) {
            if (octets[i + j] !== sequence[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function terminalRecoveryOffset(octets) {
    if (octets.length === 0) return -1;

    // These are emitted when an interactive shell redraws its prompt. If a
    // final binary chunk shares the event, expose only the terminal suffix.
    const strongMarkers = [
        [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x68], // ESC[?2004h
        [0x1b, 0x5d, 0x31, 0x33, 0x33, 0x37, 0x3b, 0x43, 0x75, 0x72, 0x72, 0x65, 0x6e, 0x74, 0x44, 0x69, 0x72, 0x3d],
    ];
    let markerOffset = -1;
    for (const marker of strongMarkers) {
        const offset = findOctetSequence(octets, marker);
        if (offset >= 0 && (markerOffset < 0 || offset < markerOffset)) markerOffset = offset;
    }
    if (markerOffset >= 0) return markerOffset;

    // Never classify a large payload chunk as terminal text based on random
    // printable/escape bytes. Plain prompts and cancellation messages are small.
    if (octets.length > 512) return -1;
    for (let i = 0; i < octets.length; i++) {
        const b = octets[i];
        if (b === 0x09 || b === 0x0d || b === 0x0a || (b >= 0x20 && b <= 0x7e)) continue;
        if (b === 0x1b && i + 1 < octets.length && (octets[i + 1] === 0x5b || octets[i + 1] === 0x5d)) continue;
        return -1;
    }
    return 0;
}

function binaryTerminalRecoveryOffset(binary) {
    const strongMarkers = ['\x1b[?2004h', '\x1b]1337;CurrentDir='];
    let markerOffset = -1;
    for (const marker of strongMarkers) {
        const offset = binary.indexOf(marker);
        if (offset >= 0 && (markerOffset < 0 || offset < markerOffset)) markerOffset = offset;
    }
    if (markerOffset >= 0) return markerOffset;
    if (binary.length > 512) return -1;
    for (let i = 0; i < binary.length; i++) {
        const b = binary.charCodeAt(i);
        if (b === 0x09 || b === 0x0d || b === 0x0a || (b >= 0x20 && b <= 0x7e)) continue;
        if (b === 0x1b && i + 1 < binary.length) {
            const next = binary.charCodeAt(i + 1);
            if (next === 0x5b || next === 0x5d) continue;
        }
        return -1;
    }
    return 0;
}

async function uint8ArrayToBase64(bytes) {
    let binary = '';
    const step = 8192;
    for (let i = 0, chunks = 0; i < bytes.length; i += step, chunks++) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
        if (chunks > 0 && chunks % ZMODEM_YIELD_EVERY_CHUNKS === 0) await sleep(0);
    }
    return btoa(binary);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Required quiet period (no dropped chunks) before drain ends, and a hard
// cap on total drain time from the moment of abort — see drainTerminalOutput.
const ZMODEM_ABORT_DRAIN_MS = 2500;
const ZMODEM_ABORT_DRAIN_MAX_MS = 8000;
const ZMODEM_ABORT_INTERRUPT_DELAY_MS = 150;
const ZMODEM_FIN_RETRY_MS = 500;
const ZMODEM_FIN_GRACE_MS = 2000;
const ZMODEM_SESSION_IDLE_TIMEOUT_MS = 120_000;
const UPLOAD_CHUNK_SIZE = 8192;
const ZMODEM_YIELD_EVERY_CHUNKS = 16;
// Batch size for both directions' chunked file IPC (save/read), matching the
// backend's zmodemChunkSize intent — small enough that no single IPC call's
// JSON.stringify/postMessage cost can noticeably stall the main thread.
const ZMODEM_FILE_IPC_CHUNK_SIZE = 512 * 1024;
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
export function createZmodemSentry(connID, term, onActive, sendBytes = sendInputBytes) {
    let senderQueue = Promise.resolve();
    let currentSession = null;
    // Only invalidate queued protocol bytes after an explicit cancellation.
    // A normal session transition must not discard its final ZFIN/ZRINIT
    // handshake while the Wails IPC queue is still draining.
    let cancelEpoch = 0;
    let suppressSender = false;
    let drainTerminalUntil = 0;
    let abortInterruptTimer = null;
    // Set when a fresh drain begins, so repeated extensions (see below) stay
    // capped relative to the original abort rather than resetting forever.
    let drainStartedAt = 0;
    let sessionActive = false;
    // null outside the final receive handshake; [] while waiting for OO.
    // Some lrzsz/PTY combinations omit OO and print the shell prompt directly.
    let pendingReceiveOO = null;
    let receiveFinRetryTimer = null;
    let receiveFinGraceTimer = null;
    const terminalOutput = createZmodemHeaderFilter();

    const isDrainingTerminal = () => Date.now() < drainTerminalUntil;
    // The library's abort() can leave the remote peer sending ZMODEM binary
    // noise for longer than any fixed guess, especially over higher-latency
    // links or with a large file already buffered — so instead of a single
    // fixed window, extend it every time more noise arrives while draining
    // (a debounce), capped at ZMODEM_ABORT_DRAIN_MAX_MS total so a peer that
    // never goes quiet can't mute the terminal indefinitely.
    const drainTerminalOutput = () => {
        const now = Date.now();
        if (drainTerminalUntil <= now) drainStartedAt = now;
        const hardCap = drainStartedAt + ZMODEM_ABORT_DRAIN_MAX_MS;
        drainTerminalUntil = Math.min(now + ZMODEM_ABORT_DRAIN_MS, hardCap);
        terminalOutput.reset();
    };

    const queuePeerBytes = (octets, { force = false } = {}) => {
        const epoch = cancelEpoch;
        const b64 = octetsToBase64(octets);
        senderQueue = senderQueue
            .then(() => {
                if (!force && epoch !== cancelEpoch) return;
                return sendBytes(connID, b64);
            })
            .catch(e => {
                console.error('zmodem sender failed:', e);
                showToast(t('zmodem.sendFailed'), 3000);
            });
    };

    // zmodem.js deliberately exposes a fire-and-forget sender.  That is a
    // good fit for a WebSocket, but each frame here crosses Wails IPC and is
    // then queued for the SSH PTY.  Bound the number of outstanding frames so
    // a large `rz` upload cannot run far ahead of the remote receiver.
    const flushPeerBytes = () => senderQueue;

    const finishSession = (session) => {
        if (session && currentSession !== session) return;
        if (receiveFinRetryTimer !== null) {
            clearTimeout(receiveFinRetryTimer);
            receiveFinRetryTimer = null;
        }
        if (receiveFinGraceTimer !== null) {
            clearTimeout(receiveFinGraceTimer);
            receiveFinGraceTimer = null;
        }
        pendingReceiveOO = null;
        currentSession = null;
        sessionActive = false;
        // Clear any stuck partial-header state so the shell's next prompt
        // (or any other post-transfer output) is never swallowed/mangled.
        terminalOutput.reset();
        hideZmodemProgress();
        onActive?.(false);
    };

    const abortSession = () => {
        const s = currentSession;
        drainTerminalOutput();
        // zmodem.js aborts its local state but emits only 5x CAN + 5x BS,
        // which some lrzsz/PTY combinations do not recognize as cancellation.
        // Suppress that short burst and send one complete Forsberg sequence.
        if (s && !s.has_ended()) {
            suppressSender = true;
            try { s.abort(); } catch {}
            finally { suppressSender = false; }
        }
        cancelEpoch += 1;
        queuePeerBytes(USER_CANCEL_OCTETS, { force: true });
        if (abortInterruptTimer !== null) clearTimeout(abortInterruptTimer);
        abortInterruptTimer = setTimeout(() => {
            abortInterruptTimer = null;
            if (!isDrainingTerminal()) return;
            queuePeerBytes([ETX], { force: true });
        }, ZMODEM_ABORT_INTERRUPT_DELAY_MS);
        finishSession(s);
    };

    let sentry;
    try {
        sentry = new Zmodem.Sentry({
            to_terminal(octets) {
                if (isDrainingTerminal()) {
                    const recoveryOffset = terminalRecoveryOffset(octets);
                    if (recoveryOffset >= 0) {
                        const recovered = octets.slice(recoveryOffset);

                        drainTerminalUntil = 0;
                        if (abortInterruptTimer !== null) {
                            clearTimeout(abortInterruptTimer);
                            abortInterruptTimer = null;
                        }
                        terminalOutput.reset();
                        term.write(new Uint8Array(recovered));
                        return;
                    }
                    // More binary noise arrived while draining: extend the
                    // quiet period, capped relative to the original abort.
                    drainTerminalOutput();
                    return;
                }
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
                if (!suppressSender) queuePeerBytes(octets);
            },
            on_retract() {
                finishSession();
            },
            on_detect(detection) {
                const zsession = detection.confirm();
                if (abortInterruptTimer !== null) {
                    clearTimeout(abortInterruptTimer);
                    abortInterruptTimer = null;
                }
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
                zsession.on('session_end', () => {
                    pendingReceiveOO = null;
                    if (zsession.aborted?.()) drainTerminalOutput();
                    finishSession(zsession);
                });
                zsession.on('receive', frame => {
                    if (zsession.type !== 'receive' || frame?.NAME !== 'ZFIN') return;
                    pendingReceiveOO = [];

                    // zmodem.js sends the matching ZFIN once and then waits
                    // indefinitely for OO. If that final response is lost, both
                    // lrzsz's `sz` and this terminal remain stuck even though all
                    // files are complete. Retry once, then finish locally for
                    // peers that omit OO entirely.
                    const zfinResponse = Zmodem.Header.build('ZFIN').to_hex();
                    receiveFinRetryTimer = setTimeout(() => {
                        receiveFinRetryTimer = null;
                        if (currentSession === zsession && pendingReceiveOO) {
                            queuePeerBytes(zfinResponse);
                        }
                    }, ZMODEM_FIN_RETRY_MS);
                    receiveFinGraceTimer = setTimeout(() => {
                        receiveFinGraceTimer = null;
                        if (currentSession !== zsession || !pendingReceiveOO) return;
                        try { zsession.consume([0x4f, 0x4f]); }
                        catch { finishSession(zsession); }
                    }, ZMODEM_FIN_GRACE_MS);
                });
                runSession(connID, zsession, flushPeerBytes)
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
        if (isDrainingTerminal()) {
            let binary;
            try {
                binary = atob(b64);
            } catch {
                return;
            }
            const recoveryOffset = binaryTerminalRecoveryOffset(binary);
            if (recoveryOffset < 0) {
                drainTerminalOutput();
                return;
            }
            const recoveredBinary = binary.slice(recoveryOffset);
            const recovered = Uint8Array.from(recoveredBinary, c => c.charCodeAt(0));

            drainTerminalUntil = 0;
            if (abortInterruptTimer !== null) {
                clearTimeout(abortInterruptTimer);
                abortInterruptTimer = null;
            }
            terminalOutput.reset();
            term.write(recovered);
            return;
        }
        let bytes;
        try {
            bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        } catch {
            return;
        }

        if (pendingReceiveOO) {
            const combined = new Uint8Array(pendingReceiveOO.length + bytes.length);
            combined.set(pendingReceiveOO);
            combined.set(bytes, pendingReceiveOO.length);
            if (combined.length === 1 && combined[0] === 0x4f) {
                pendingReceiveOO = [0x4f];
                return;
            }
            pendingReceiveOO = null;
            if (combined[0] === 0x4f && combined[1] === 0x4f) {
                bytes = combined;
            } else {
                bytes = new Uint8Array([0x4f, 0x4f, ...combined]);
            }
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

async function runSession(connID, zsession, flushPeerBytes = async () => {}) {
    if (zsession.type === 'receive') {
        await receiveFiles(zsession);
    } else {
        await sendFiles(connID, zsession, flushPeerBytes);
    }
}

// sz on server → we receive files
async function receiveFiles(zsession) {
    showToast(t('zmodem.receiving'));

    const transferPromises = [];
    const aborted = new Promise(resolve => {
        zsession.on('session_end', () => {
            if (zsession.aborted?.()) resolve();
        });
    });

    zsession.on('offer', offer => {
        const { name, size } = offer.get_details();
        showZmodemProgress(name, 'receive', size);
        const p = (async () => {
            let handle;
            try {
                handle = await openZmodemFile(name);
                let batch = [];
                let batchLen = 0;
                let writeError;
                let writeQueue = Promise.resolve();
                const flushBatch = () => {
                    if (batchLen === 0) return;
                    const merged = new Uint8Array(batchLen);
                    let off = 0;
                    for (const c of batch) { merged.set(c, off); off += c.length; }
                    batch = [];
                    batchLen = 0;
                    writeQueue = writeQueue.then(async () => {
                        if (writeError) return;
                        await writeZmodemFileChunk(handle, await uint8ArrayToBase64(merged));
                        await sleep(0);
                    }).catch(e => {
                        writeError = e;
                        if (!zsession.aborted?.()) {
                            try { zsession.abort(); } catch {}
                        }
                    });
                };

                const accepted = offer.accept({
                    on_input(chunk) {
                        const copy = Uint8Array.from(chunk);
                        batch.push(copy);
                        batchLen += copy.length;
                        updateZmodemProgress(offer.get_offset());
                        if (batchLen >= ZMODEM_FILE_IPC_CHUNK_SIZE) flushBatch();
                    },
                });

                // zmodem.js does not reject an in-flight accept() on abort.
                // Race it so cancellation always closes and deletes the partial file.
                await Promise.race([accepted, aborted.then(() => { throw new Zmodem.Error('aborted'); })]);
                flushBatch();
                await writeQueue;
                if (writeError) throw writeError;
                updateZmodemProgress(offer.get_offset(), { force: true });
                const savedPath = await closeZmodemFile(handle);
                handle = null;
                showToast(t('zmodem.downloaded', { name, path: savedPath }), 4000);
            } catch (e) {
                if (handle) {
                    try { await abortZmodemFile(handle); } catch {}
                }
                if (!zsession.aborted?.() && !String(e?.message ?? e).includes('aborted')) {
                    showToast(t('zmodem.saveFailed', { name, e }), 3000);
                    console.error('zmodem saveZmodemFile:', e);
                }
            }
        })();
        transferPromises.push(p);
    });

    // Wait for session to end, with a 2-minute inactivity timeout. A batch may
    // legitimately take longer, so protocol frames and offers refresh it.
    // Register this before start(): a fast local/SSH peer may complete the
    // final handshake before a later listener could observe it.
    const sessionEnd = new Promise(resolve => zsession.on('session_end', resolve));
    let timeoutID;
    let rejectTimeout;
    const timeout = new Promise((_, reject) => {
        rejectTimeout = reject;
    });
    const refreshTimeout = () => {
        clearTimeout(timeoutID);
        timeoutID = setTimeout(() => rejectTimeout(new Error('timeout')), ZMODEM_SESSION_IDLE_TIMEOUT_MS);
    };
    zsession.on('receive', refreshTimeout);
    zsession.on('offer', refreshTimeout);

    // start() sends ZRINIT to the server, initiating the transfer handshake.
    refreshTimeout();
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
async function sendFiles(connID, zsession, flushPeerBytes) {
    showToast(t('zmodem.selectFiles'));

    let files;
    try {
        files = await pickFilesForZmodem();
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

        const xfer = await zsession.send_offer({ name: file.name, size: file.size });
        if (zsession.aborted?.()) throw new Zmodem.Error('aborted');
        if (xfer === undefined) continue; // remote skipped this file

        showZmodemProgress(file.name, 'send', file.size);
        // Read the file in ~512KB IPC chunks instead of one openFilesForZmodem
        // call that decoded the entire file up front — same reasoning as the
        // download side's chunked save. The wire-level send pacing below
        // (8192-byte pieces, yield every 16) is unchanged; only where `bytes`
        // comes from changed.
        const handle = await openZmodemUploadFile(file.path);
        try {
            // A receiver may request a non-zero ZRPOS when it is resuming a
            // partial transfer.  The protocol frame already starts at that
            // offset; seek the local source to keep its payload aligned.
            let skip = xfer.get_offset();
            let chunks = 0;
            let eof = false;
            while (!eof) {
                if (zsession.aborted?.()) throw new Zmodem.Error('aborted');
                const res = await readZmodemFileChunk(handle);
                eof = res.eof;
                const bytes = Uint8Array.from(atob(res.chunk || ''), c => c.charCodeAt(0));
                let start = 0;
                if (skip > 0) {
                    const skipped = Math.min(skip, bytes.length);
                    skip -= skipped;
                    start = skipped;
                }
                for (let i = start; i < bytes.length; i += UPLOAD_CHUNK_SIZE) {
                    if (zsession.aborted?.()) throw new Zmodem.Error('aborted');
                    xfer.send(bytes.subarray(i, Math.min(i + UPLOAD_CHUNK_SIZE, bytes.length)));
                    updateZmodemProgress(xfer.get_offset());
                    chunks++;
                    if (chunks % ZMODEM_YIELD_EVERY_CHUNKS === 0) {
                        await flushPeerBytes();
                        await sleep(0);
                    }
                }
            }
            if (skip > 0) throw new Error('Zmodem resume offset exceeds local file size');
            await flushPeerBytes();
        } finally {
            try { await closeZmodemUploadFile(handle); } catch {}
        }
        if (zsession.aborted?.()) throw new Zmodem.Error('aborted');
        await xfer.end();
        updateZmodemProgress(xfer.get_offset(), { force: true });
    }

    if (zsession.aborted?.()) throw new Zmodem.Error('aborted');
    await zsession.close();
    showToast(t('zmodem.uploadComplete'), 3000);
}
