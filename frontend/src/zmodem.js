import Zmodem from 'zmodem.js';
import { sendInputBytes, openFilesForZmodem, saveZmodemFile } from './api.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';

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
    let sendEpoch = 0;
    let forceSender = false;
    let drainTerminalUntil = 0;

    const isDrainingTerminal = () => Date.now() < drainTerminalUntil;
    const drainTerminalOutput = () => {
        drainTerminalUntil = Math.max(drainTerminalUntil, Date.now() + ZMODEM_ABORT_DRAIN_MS);
    };

    const queuePeerBytes = (octets, { force = false } = {}) => {
        const epoch = sendEpoch;
        const b64 = octetsToBase64(octets);
        senderQueue = senderQueue
            .then(() => {
                if (!force && epoch !== sendEpoch) return;
                return sendInputBytes(connID, b64);
            })
            .catch(e => {
                console.error('zmodem sender failed:', e);
                showToast(t('zmodem.sendFailed'), 3000);
            });
    };

    const abortSession = () => {
        const s = currentSession;
        drainTerminalOutput();
        if (s && !s.has_ended()) {
            forceSender = true;
            try { s.abort(); } catch {}
            finally { forceSender = false; }
        }
        sendEpoch += 1;
        queuePeerBytes(USER_CANCEL_OCTETS, { force: true });
        currentSession = null;
        onActive?.(false);
    };

    let sentry;
    try {
        sentry = new Zmodem.Sentry({
            to_terminal(octets) {
                if (isDrainingTerminal()) return;
                term.write(new Uint8Array(octets));
            },
            sender(octets) {
                queuePeerBytes(octets, { force: forceSender });
            },
            on_retract() {
                currentSession = null;
                onActive?.(false);
            },
            on_detect(detection) {
                const zsession = detection.confirm();
                sendEpoch += 1;
                drainTerminalUntil = 0;
                currentSession = zsession;
                onActive?.(true);
                runSession(connID, zsession)
                    .catch(e => {
                        const msg = String(e?.message ?? e);
                        if (!msg.includes('aborted') && !msg.includes('peer_aborted') && !msg.includes('timeout')) {
                            console.error('zmodem session error:', e);
                            showToast(t('zmodem.error', { msg }), 3000);
                        }
                    })
                    .finally(() => {
                        currentSession = null;
                        onActive?.(false);
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
            sentry.consume(bytes);
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

    // start() sends ZRINIT to the server, initiating the transfer handshake.
    zsession.start();

    // Wait for session to end, with a 2-minute safety timeout.
    const SESSION_TIMEOUT_MS = 120_000;
    const sessionEnd = new Promise(resolve => zsession.on('session_end', resolve));
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), SESSION_TIMEOUT_MS));

    await Promise.race([sessionEnd, timeout]).catch(e => {
        try { zsession.abort(); } catch {}
        if (String(e?.message).includes('timeout')) {
            showToast(t('zmodem.timedOut'), 3000);
        }
    });

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
