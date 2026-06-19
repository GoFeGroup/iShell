import Zmodem from 'zmodem.js';
import { sendInputBytes, openFilesForZmodem, saveZmodemFile } from './api.js';
import { showToast } from './toast.js';

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

// Creates a Zmodem-aware data consumer for a terminal connection.
// Returns { consume(b64), abort() }.
// onActive(bool) is called when a Zmodem session starts (true) or ends (false).
export function createZmodemSentry(connID, term, onActive) {
    let senderQueue = Promise.resolve();
    let currentSession = null;

    const abortSession = () => {
        const s = currentSession;
        if (s && !s.has_ended()) {
            try { s.abort(); } catch {}
        }
        currentSession = null;
        onActive?.(false);
    };

    let sentry;
    try {
        sentry = new Zmodem.Sentry({
            to_terminal(octets) {
                term.write(new Uint8Array(octets));
            },
            sender(octets) {
                const b64 = octetsToBase64(octets);
                senderQueue = senderQueue
                    .then(() => sendInputBytes(connID, b64))
                    .catch(e => {
                        console.error('zmodem sender failed:', e);
                        showToast('Zmodem: send failed — check connection', 3000);
                    });
            },
            on_retract() {
                currentSession = null;
                onActive?.(false);
            },
            on_detect(detection) {
                const zsession = detection.confirm();
                currentSession = zsession;
                onActive?.(true);
                runSession(connID, zsession)
                    .catch(e => {
                        const msg = String(e?.message ?? e);
                        if (!msg.includes('aborted') && !msg.includes('peer_aborted') && !msg.includes('timeout')) {
                            console.error('zmodem session error:', e);
                            showToast(`Zmodem error: ${msg}`, 3000);
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
            try { term.write(bytes); } catch {}
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
    showToast('Receiving file via Zmodem (sz)...');

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
                showToast(`Downloaded: ${name}  →  ${savedPath}`, 4000);
            } catch (e) {
                showToast(`Save failed (${name}): ${e}`, 3000);
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
            showToast('Zmodem timed out — session aborted', 3000);
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
    showToast('Select file(s) to upload via Zmodem (rz)...');

    let files;
    try {
        files = await openFilesForZmodem();
    } catch (e) {
        try { zsession.abort(); } catch {}
        showToast(`Zmodem upload cancelled: ${e}`, 3000);
        return;
    }

    if (!files || files.length === 0) {
        try { zsession.abort(); } catch {}
        showToast('Zmodem upload cancelled', 2000);
        return;
    }

    showToast(`Sending ${files.length} file(s) via Zmodem...`);

    for (const file of files) {
        const bytes = Uint8Array.from(atob(file.content), c => c.charCodeAt(0));

        const xfer = await zsession.send_offer({ name: file.name, size: file.size });
        if (xfer === undefined) continue; // remote skipped this file

        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            xfer.send(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
        }
        await xfer.end();
    }

    await zsession.close();
    showToast('Zmodem upload complete', 3000);
}
