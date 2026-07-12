// Floating progress indicator for an active ZMODEM (sz/rz) transfer.
// One global instance, mirroring the #kb-toast singleton: only one ZMODEM
// session can be active per terminal, and this reflects whichever one last
// reported progress.

const UPDATE_INTERVAL_MS = 150;
const HIDE_DELAY_MS = 300;

let state = null; // { total, lastTime, lastBytes }
let hideTimer = null;

function els() {
    const wrap = document.getElementById('zmodem-progress');
    if (!wrap) return null;
    return {
        wrap,
        icon: document.getElementById('zp-icon'),
        name: document.getElementById('zp-name'),
        fill: document.getElementById('zp-fill'),
        pct: document.getElementById('zp-pct'),
        speed: document.getElementById('zp-speed'),
    };
}

function fmtSize(b) {
    if (b < 1024) return Math.round(b) + ' B';
    const units = ['KB', 'MB', 'GB'];
    let i = -1;
    do { b /= 1024; i++; } while (b >= 1024 && i < units.length - 1);
    return b.toFixed(1) + ' ' + units[i];
}

export function showZmodemProgress(name, direction, total) {
    clearTimeout(hideTimer);
    const e = els();
    if (!e) return;
    state = { total, lastTime: Date.now(), lastBytes: 0 };
    e.icon.textContent = direction === 'send' ? '⬆' : '⬇';
    e.name.textContent = name;
    e.fill.className = 'progress-fill ' + (direction === 'send' ? 'uploading' : 'downloading');
    e.fill.style.width = total > 0 ? '0%' : '8%';
    e.pct.textContent = total > 0 ? '0%' : '';
    e.speed.textContent = '';
    e.wrap.classList.add('show');
}

// loaded is cumulative bytes transferred so far for the current file.
export function updateZmodemProgress(loaded, { force = false } = {}) {
    if (!state) return;
    const now = Date.now();
    if (!force && now - state.lastTime < UPDATE_INTERVAL_MS) return;
    const e = els();
    if (!e) return;

    const elapsedSec = (now - state.lastTime) / 1000;
    const bps = elapsedSec > 0 ? (loaded - state.lastBytes) / elapsedSec : 0;
    state.lastTime = now;
    state.lastBytes = loaded;

    const known = state.total > 0;
    const percent = known ? Math.min(100, Math.round((loaded / state.total) * 100)) : 0;
    e.fill.style.width = known ? percent + '%' : '8%';
    e.pct.textContent = known ? percent + '%' : '';
    if (bps > 0) e.speed.textContent = fmtSize(bps) + '/s';
}

export function hideZmodemProgress() {
    state = null;
    clearTimeout(hideTimer);
    const e = els();
    if (!e) return;
    hideTimer = setTimeout(() => e.wrap.classList.remove('show'), HIDE_DELAY_MS);
}
