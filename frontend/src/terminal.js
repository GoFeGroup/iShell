import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { sendInput, resizeTerm, on, off } from './api.js';
import { findQuickCommandByShortcut } from './quick-command.js';
import { createZmodemSentry } from './zmodem.js';

const isMac = navigator.platform.startsWith('Mac');
const instances = {};  // connID → { term, fitAddon, resizeObs, dataHandler, xtermEl }
const cwdByConn = {};
const DEFAULT_FONT_SIZE = 16;
const RESTORE_DELAYS = [0, 50, 150, 300];
const INPUT_CHUNK_SIZE = 8192;
const INPUT_YIELD_EVERY_CHUNKS = 8;
const PERF_DEBUG = true;
let autoFitSuspended = false;

function perfLog(label, ...args) {
  if (PERF_DEBUG) console.log('[PERF-FIT]', label, ...args);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkEndFor(text, start) {
  let end = Math.min(start + INPUT_CHUNK_SIZE, text.length);
  if (end < text.length) {
    const lastCode = text.charCodeAt(end - 1);
    if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
      end -= 1;
    }
  }
  return end;
}

function makeInputSender(connID) {
  const queue = [];
  let head = 0;
  let offset = 0;
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      let sentSinceYield = 0;
      while (head < queue.length) {
        const text = queue[head];
        const end = chunkEndFor(text, offset);
        const payload = text.slice(offset, end);
        try {
          await sendInput(connID, payload);
          offset = end;
          if (offset >= text.length) {
            head += 1;
            offset = 0;
            if (head > 64 && head * 2 > queue.length) {
              queue.splice(0, head);
              head = 0;
            }
          }
          sentSinceYield += 1;
          if (sentSinceYield >= INPUT_YIELD_EVERY_CHUNKS) {
            sentSinceYield = 0;
            await sleep(0);
          }
        } catch (e) {
          console.error('sendInput:', e);
          await sleep(8);
        }
      }
    } finally {
      draining = false;
      if (head < queue.length) drain();
    }
  }

  return (data) => {
    if (!data) return;
    queue.push(data);
    drain();
  };
}

function rememberViewport(inst) {
  if (!inst) return;
  const buf = inst.term.buffer.active;
  inst.savedViewportY = buf.viewportY;
  inst.savedBaseY = buf.baseY;
}

// After a DOM re-attach or fit, .xterm-viewport.scrollTop can be reset while
// xterm's internal ydisp is preserved. Restore from our last stable snapshot
// instead of reading a possibly changing viewport during touchpad inertia.
function syncViewportScroll(inst, snapshot = null) {
  if (!inst) return;
  const buf = inst.term.buffer.active;
  const vp = inst.xtermEl.querySelector('.xterm-viewport');
  if (!vp) return;
  const targetViewportY = snapshot?.viewportY ?? inst.savedViewportY ?? buf.viewportY;
  const targetBaseY = snapshot?.baseY ?? inst.savedBaseY ?? buf.baseY;
  if (targetViewportY >= targetBaseY) {
    inst.term.scrollToBottom();
    vp.scrollTop = vp.scrollHeight;
  } else {
    // User had scrolled up (e.g. via touchpad). The DOM viewport scrollTop was
    // reset to 0 on re-attach while xterm's internal ydisp is unchanged, so
    // scrollToLine(target) alone is a no-op (it short-circuits when the delta is
    // 0) and proportional pixel math is unreliable because scrollHeight can be
    // stale in WKWebView right after re-attach. Nudge ydisp to an adjacent line
    // first to force xterm to re-sync the DOM scrollTop itself using its exact
    // rendered cell height, then land back on the saved line.
    const target = Math.max(0, Math.min(targetViewportY, buf.baseY));
    if (buf.baseY <= 0) {
      vp.scrollTop = 0;
      return;
    }
    inst.term.scrollToLine(target > 0 ? target - 1 : 1);
    inst.term.scrollToLine(target);
  }
}

function scheduleViewportRestore(connID, delays = RESTORE_DELAYS, snapshot = null, markTabSwitch = false) {
  const inst = instances[connID];
  if (!inst) return;
  const canceled = inst.restoreTimers?.length || 0;
  cancelViewportRestore(inst);
  if (!snapshot) {
    rememberViewport(inst);
  }
  const restoreSeq = (inst.restoreSeq || 0) + 1;
  inst.restoreSeq = restoreSeq;
  if (markTabSwitch) inst._lastTabSwitch = Date.now();
  const restoreSnapshot = snapshot || {
    viewportY: inst.savedViewportY,
    baseY: inst.savedBaseY,
  };
  inst.restoreSnapshot = restoreSnapshot;
  inst.restoreTimers = [];
  perfLog('scheduleViewportRestore', {
    connID,
    delays,
    canceled,
    markTabSwitch,
    snapshot: restoreSnapshot,
  });

  delays.forEach(delay => {
    const run = () => {
      const current = instances[connID];
      if (!current || current.restoreSeq !== restoreSeq) return;
      syncViewportScroll(current, restoreSnapshot);
    };
    if (delay === 0) {
      const first = requestAnimationFrame(() => {
        const second = requestAnimationFrame(run);
        inst.restoreTimers.push({ type: 'raf', id: second });
      });
      inst.restoreTimers.push({ type: 'raf', id: first });
    } else {
      const id = setTimeout(run, delay);
      inst.restoreTimers.push({ type: 'timeout', id });
    }
  });
}

function cancelViewportRestore(inst) {
  inst.restoreTimers?.forEach(timer => {
    if (timer.type === 'raf') cancelAnimationFrame(timer.id);
    else clearTimeout(timer.id);
  });
  inst.restoreTimers = [];
}

function cancelPendingFit(inst) {
  if (inst?.pendingFitRAF) {
    perfLog('cancelPendingFit', { connID: inst.connID });
    cancelAnimationFrame(inst.pendingFitRAF);
  }
  if (inst) inst.pendingFitRAF = 0;
}

function scheduleTerminalFit(connID, inst, options = {}) {
  if (!inst) return;
  if (autoFitSuspended && options.caller === 'ResizeObserver') {
    inst.needsFitAfterSuspend = true;
    perfLog('scheduleTerminalFit suspended', { connID, caller: options.caller || '' });
    return;
  }
  const requestedAt = performance.now();
  cancelPendingFit(inst);
  perfLog('scheduleTerminalFit', {
    connID,
    restoreScroll: !!options.restoreScroll,
    caller: options.caller || '',
  });
  inst.pendingFitRAF = requestAnimationFrame(() => {
    inst.pendingFitRAF = 0;
    if (instances[connID] !== inst) return;
    perfLog('runTerminalFit', {
      connID,
      caller: options.caller || '',
      wait: (performance.now() - requestedAt).toFixed(1) + 'ms',
    });
    fitVisibleTerminal(connID, inst, options);
  });
}

function visibleTerminalRect(inst) {
  const el = inst?.containerEl;
  if (!el || !el.isConnected) return null;
  const tabContent = el.closest('.terminal-tab-content');
  if (tabContent && !tabContent.classList.contains('active')) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(el).display === 'none') return null;
  return rect;
}

function fitVisibleTerminal(connID, inst, { restoreScroll = false, snapshot = null } = {}) {
  const rect = visibleTerminalRect(inst);
  if (!rect) return false;
  const startedAt = performance.now();
  const restoreSnapshot = restoreScroll ? (snapshot || {
    viewportY: inst.savedViewportY ?? inst.term.buffer.active.viewportY,
    baseY: inst.savedBaseY ?? inst.term.buffer.active.baseY,
  }) : null;
  const prevCols = inst.term.cols, prevRows = inst.term.rows;
  inst.fitAddon.fit();
  const resized = inst.term.cols !== prevCols || inst.term.rows !== prevRows;
  if (resized) {
    resizeTerm(connID, inst.term.cols, inst.term.rows).catch(() => {});
  }
  const sizeEl = document.getElementById(inst.sizeElId || 'sb-size');
  if (sizeEl) sizeEl.textContent = `${inst.term.cols}×${inst.term.rows}`;
  if (restoreScroll) scheduleViewportRestore(connID, RESTORE_DELAYS, restoreSnapshot);
  inst.lastFitWidth = rect.width;
  inst.lastFitHeight = rect.height;
  perfLog('fitVisibleTerminal', {
    connID,
    restoreScroll,
    resized,
    cols: `${prevCols}->${inst.term.cols}`,
    rows: `${prevRows}->${inst.term.rows}`,
    cost: (performance.now() - startedAt).toFixed(1) + 'ms',
  });
  return true;
}

function isGlobalAppShortcut(e) {
  if (e.type !== 'keydown') return false;
  if (findQuickCommandByShortcut(e)) return true;
  const key = e.key.toLowerCase();
  const appMod = isMac ? (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) : (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey);
  if (e.key === 'Enter' && (isMac ? e.metaKey : e.altKey)) return true;
  if (!appMod) return false;
  return key === 'w' ||
    key === 'b' ||
    key === 'f' ||
    key === 'o' ||
    key === ',' ||
    (e.key >= '1' && e.key <= '9');
}

function blockAppShortcut(e) {
  if (!isGlobalAppShortcut(e)) return false;
  // main.js handles global shortcuts during document capture; here we only stop
  // xterm from sending the same key sequence to the shell.
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation?.();
  return true;
}

export function createTerminal(connID, settings, options = {}) {
  const containerId = options.containerId || 'terminal-container';
  const sizeElId = options.sizeElId || 'sb-size';
  const container = document.getElementById(containerId);
  if (!container) return null;

  const resolvedFont = settings?.font_family || "Menlo, Monaco, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, monospace";
  const resolvedSize = connID.startsWith('local-') ? DEFAULT_FONT_SIZE : (settings?.font_size || DEFAULT_FONT_SIZE);

  // Reuse existing terminal unless font settings changed.
  if (instances[connID]) {
    const inst = instances[connID];
    if (inst.fontFamily === resolvedFont && inst.fontSize === resolvedSize) {
      rememberViewport(inst);
      const alreadyMounted = inst.xtermEl.parentElement === container;
      if (!alreadyMounted) {
        const restoreSnapshot = {
          viewportY: inst.savedViewportY,
          baseY: inst.savedBaseY,
        };
        scheduleViewportRestore(connID, RESTORE_DELAYS, restoreSnapshot, true);
        container.innerHTML = '';
        container.appendChild(inst.xtermEl);
        inst.resizeObs.disconnect();
        inst.resizeObs.observe(container);
        // Defer fit after a real DOM move. When the terminal is already mounted
        // in this tab's container, keep the existing xterm DOM/history intact
        // and let ResizeObserver handle only actual size changes.
        scheduleTerminalFit(connID, inst, { restoreScroll: true, snapshot: restoreSnapshot, caller: 'createTerminal-RAF' });
      } else {
        cancelPendingFit(inst);
        perfLog('reuseMountedTerminal skip fit', { connID, containerId });
      }
      inst.containerEl = container;
      inst.containerId = containerId;
      inst.sizeElId = sizeElId;
      return inst.term;
    }
    // Font changed: tear down old instance and fall through to rebuild.
    off('terminal:data:' + connID);
    inst.disposables?.forEach(d => d.dispose());
    inst.xtermEl.removeEventListener('compositionstart', inst.compositionStartHandler, true);
    inst.xtermEl.removeEventListener('compositionend', inst.compositionEndHandler, true);
    inst.xtermEl.removeEventListener('beforeinput', inst.beforeInputHandler, true);
    inst.xtermEl.removeEventListener('paste', inst.pasteHandler, true);
    inst.xtermEl.removeEventListener('mousedown', inst.mouseDownHandler, true);
    inst.xtermEl.removeEventListener('contextmenu', inst.contextMenuHandler);
    document.removeEventListener('mousemove', inst.mouseMoveHandler, true);
    document.removeEventListener('mouseup',   inst.mouseUpHandler,   true);
    inst.resizeObs.disconnect();
    cancelPendingFit(inst);
    cancelViewportRestore(inst);
    inst.term.dispose();
    delete instances[connID];
  }

  container.innerHTML = '';

  const xtermEl = document.createElement('div');
  xtermEl.style.cssText = 'width:100%;height:100%;';
  container.appendChild(xtermEl);

  // Menlo/Monaco are pre-installed on every Mac and are proper ASCII-width monospace fonts.
  // Listing them before the generic `monospace` prevents xterm from falling back to a
  // CJK full-width font (e.g. STFangsong) on Chinese macOS, which makes cell width 2x.
  const term = new Terminal({
    fontSize: resolvedSize,
    fontFamily: resolvedFont,
    letterSpacing: 0,
    cursorBlink: settings?.cursor_blink !== false,
    cursorStyle: settings?.cursor_style || 'block',
    scrollback: settings?.scrollback || 10000,
    theme: buildTheme(),
    allowTransparency: false,
    convertEol: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon((event, uri) => {
    if (!(isMac ? event.metaKey : event.altKey)) return;
    window.runtime.BrowserOpenURL(uri);
  }));
  term.open(xtermEl);

  // GPU-accelerated rendering — much cheaper to repaint than xterm's default
  // DOM renderer, especially noticeable on macOS WKWebView. Falls back to the
  // default DOM renderer automatically if WebGL is unavailable or the context
  // is lost (e.g. GPU driver reset).
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => webglAddon.dispose());
    term.loadAddon(webglAddon);
  } catch { /* WebGL unavailable — keep the default DOM renderer */ }

  // Parse CWD reports emitted by shells/terminal integrations.
  const osc7Disposable = term.parser.registerOscHandler(7, (data) => {
    try {
      const url = new URL(data);
      setTerminalCWD(connID, decodeURIComponent(url.pathname));
    } catch {}
    return false;
  });
  const osc1337Disposable = term.parser.registerOscHandler(1337, (data) => {
    const cwd = parseCurrentDir(data);
    if (cwd) setTerminalCWD(connID, cwd);
    return false;
  });

  fitAddon.fit();
  // Sync initial PTY size immediately; ResizeObserver handles subsequent resizes.
  resizeTerm(connID, term.cols, term.rows).catch(() => {});

  const sendTerminalInput = makeInputSender(connID);
  const flushInput = (data) => {
    const inst = instances[connID];
    if (!inst?.inputEnabled) {
      if (data === '\r') {
        console.log('[reconnect] onData Enter while disabled', { connID, hasCallback: !!inst?.reconnectCallback });
        inst?.reconnectCallback?.();
      }
      return;
    }
    sendTerminalInput(data);
  };
  let zmodemActive = false;
  let suppressPasteUntil = 0;
  let composing = false;
  let pendingComposition = null;
  const pasteIntoTerminal = (text) => {
    if (!text) return;
    term.clearSelection();
    term.paste(text);
  };

  const compositionStartHandler = () => {
    composing = true;
    pendingComposition = null;
  };

  const compositionEndHandler = (e) => {
    composing = false;
    const text = e.data || '';
    if (!text) return;

    // xterm normally emits the committed IME text through onData. In Wails on
    // macOS that event can be missed, so send the composition result only if
    // xterm does not report the same text immediately after compositionend.
    const marker = { text, seenText: '' };
    pendingComposition = marker;
    setTimeout(() => {
      if (pendingComposition === marker && marker.seenText !== text) {
        flushInput(text);
      }
      if (pendingComposition === marker) pendingComposition = null;
    }, 30);
  };

  xtermEl.addEventListener('compositionstart', compositionStartHandler, true);
  xtermEl.addEventListener('compositionend', compositionEndHandler, true);

  // Tracks the last single char sent by onData so beforeInputHandler can skip
  // it and avoid sending it twice (xterm fires onData from keydown; beforeinput
  // fires afterwards in the same task; both would call flushInput otherwise).
  // When CJK IME is active WebKit reports keyCode 229 for every keydown and
  // xterm ignores it, so onData does NOT fire — beforeInputHandler is the only
  // path and must still call flushInput.
  let onDataHandledChar = null;

  // IME-composed text (Chinese, Japanese, etc.) should arrive here after composition ends.
  let zmodem; // assigned below after sentry is created

  const dataDisposable = term.onData(data => {
    if (zmodemActive) {
      if (data === '\x03') zmodem?.abort(); // Ctrl+C aborts a stuck Zmodem session
      return;
    }
    if (pendingComposition) {
      const nextSeenText = pendingComposition.seenText + data;
      if (pendingComposition.text.startsWith(nextSeenText)) {
        pendingComposition.seenText = nextSeenText;
        if (pendingComposition.seenText === pendingComposition.text) {
          pendingComposition = null;
        }
      } else if (data === pendingComposition.text) {
        pendingComposition = null;
      }
    }
    if (data.length === 1) onDataHandledChar = data;
    flushInput(data);
  });
  const scrollDisposable = term.onScroll(() => {
    const inst = instances[connID];
    if (inst) rememberViewport(inst);
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Let xterm handle IME composition natively; onData delivers the final composed text.
    if (e.isComposing || composing || e.key === 'Process') return true;
    if (blockAppShortcut(e)) return false;

    const key = e.key.toLowerCase();

    // Copy: Cmd+C (Mac) or Ctrl+Shift+C (Win/Linux)
    if (isMac ? (e.metaKey && key === 'c') : (e.ctrlKey && e.shiftKey && key === 'c')) {
      const sel = term.getSelection();
      if (sel) window.runtime.ClipboardSetText(sel).catch(() => {});
      return false;
    }

    // Paste: Cmd+V (Mac) or Ctrl+Shift+V (Win/Linux)
    if (isMac ? (e.metaKey && key === 'v') : (e.ctrlKey && e.shiftKey && key === 'v')) {
      suppressPasteUntil = Date.now() + 500;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      window.runtime.ClipboardGetText()
        .then(pasteIntoTerminal)
        .catch(() => {});
      return false;
    }

    return true;
  });

  // Direct-typing fast path: handle "insertText" ourselves so it never goes
  // through xterm's lossy textarea path. IME composition (insertCompositionText,
  // insertFromComposition) is left for xterm, so Chinese/Japanese input is
  // unaffected. Capture phase runs before xterm's own textarea listener.
  const beforeInputHandler = (e) => {
    if (composing || zmodemActive) return;
    if (e.inputType === 'insertText' && e.data) {
      e.preventDefault();
      // onData already handled this char via xterm's keydown path; skip to
      // avoid sending it twice. Clear the flag regardless so it doesn't persist.
      const alreadySent = onDataHandledChar === e.data;
      onDataHandledChar = null;
      if (!alreadySent) flushInput(e.data);
    }
  };
  xtermEl.addEventListener('beforeinput', beforeInputHandler, true);

  // Handles right-click "Paste" from context menu; keyboard paste is handled above.
  const pasteHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    if (zmodemActive || Date.now() < suppressPasteUntil) {
      return;
    }
    const text = e.clipboardData?.getData('text');
    if (text) { pasteIntoTerminal(text); return; }
    window.runtime.ClipboardGetText()
      .then(pasteIntoTerminal)
      .catch(() => {});
  };
  xtermEl.addEventListener('paste', pasteHandler, true);

  // iTerm2-style selection: drag creates selection; single click just positions cursor.
  const DRAG_THRESHOLD = 4;
  const CLICK_CLUSTER_RADIUS = 4;
  const MULTI_CLICK_THRESHOLD = 500;
  // How long the finger must be held after a multi-click before a move is treated
  // as intentional drag (word-by-word extend) rather than touchpad tap jitter.
  const MULTI_CLICK_DRAG_HOLD_MS = 300;
  let mouseDownPos = null;
  let mouseDownTarget = null;
  let lastClickInfo = null;
  let replayingMouseEvent = false;
  let isDragging = false;
  const isMouseTrackingActive = () => {
    const mode = term.modes?.mouseTrackingMode;
    return !!mode && mode !== 'none';
  };
  const copySelectionToClipboard = ({ defer = false } = {}) => {
    const copy = () => {
      const sel = term.getSelection();
      if (sel) window.runtime.ClipboardSetText(sel).catch(() => {});
    };
    if (defer) {
      requestAnimationFrame(copy);
    } else {
      copy();
    }
  };

  const getClickDetail = (e) => {
    const nativeDetail = Math.max(1, e.detail);
    if (!lastClickInfo) {
      return nativeDetail;
    }

    const dx = e.clientX - lastClickInfo.clientX;
    const dy = e.clientY - lastClickInfo.clientY;
    const dt = e.timeStamp - lastClickInfo.timeStamp;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const isSameClickCluster = dt <= MULTI_CLICK_THRESHOLD && dist < CLICK_CLUSTER_RADIUS;

    if (!isSameClickCluster) {
      return nativeDetail;
    }
    if (nativeDetail > 1) {
      return Math.min(3, nativeDetail);
    }
    if (lastClickInfo.detail >= 2) {
      return 1;
    }
    return 2;
  };

  const replayMouseEvent = (target, sourceEvent, type, buttons, detail = sourceEvent.detail) => {
    replayingMouseEvent = true;
    try {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        detail,
        screenX: sourceEvent.screenX,
        screenY: sourceEvent.screenY,
        clientX: sourceEvent.clientX,
        clientY: sourceEvent.clientY,
        button: sourceEvent.button,
        buttons,
        ctrlKey: sourceEvent.ctrlKey,
        shiftKey: sourceEvent.shiftKey,
        altKey: sourceEvent.altKey,
        metaKey: sourceEvent.metaKey,
      }));
    } finally {
      replayingMouseEvent = false;
    }
  };

  const mouseDownHandler = (e) => {
    if (replayingMouseEvent) return;
    if (e.button !== 0) return;
    if (isMouseTrackingActive()) return;
    if (e.shiftKey) {
      // Shift+click: xterm handles extending the existing selection.
      isDragging = true;
      return;
    }
    isDragging = false;
    const detail = getClickDetail(e);
    mouseDownPos = {
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
      timeStamp: e.timeStamp,
      detail,
      button: e.button,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    };
    mouseDownTarget = e.target;
    term.focus();
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
  };

  const mouseMoveHandler = (e) => {
    if (replayingMouseEvent) return;
    // when isDragging: return without stopping so native events reach xterm's own handlers
    if (!mouseDownPos || isDragging) return;
    if (isMouseTrackingActive()) return;
    if ((e.buttons & 1) === 0) return;
    if (mouseDownPos.detail >= 2 &&
        e.timeStamp - mouseDownPos.timeStamp < MULTI_CLICK_DRAG_HOLD_MS) {
      // Suppress drag from a quick multi-tap (touchpad jitter between taps).
      // A deliberate hold-then-drag (>MULTI_CLICK_DRAG_HOLD_MS) falls through
      // so iTerm2-style word-by-word drag selection still works.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      return;
    }
    const dx = e.clientX - mouseDownPos.clientX;
    const dy = e.clientY - mouseDownPos.clientY;
    if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      return;
    }

    isDragging = true;
    const target = mouseDownTarget?.isConnected ? mouseDownTarget : xtermEl;
    replayMouseEvent(target, mouseDownPos, 'mousedown', 1);
    replayMouseEvent(target, e, 'mousemove', e.buttons || 1, 0);
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
  };

  const mouseUpHandler = (e) => {
    if (replayingMouseEvent) return;
    if (e.button !== 0) return;
    if (isMouseTrackingActive()) {
      mouseDownPos = null;
      mouseDownTarget = null;
      isDragging = false;
      return;
    }
    if (isDragging) {
      // Drag selection: keep selection visible and copy it when selection completes.
      copySelectionToClipboard({ defer: true });
    } else if (mouseDownPos) {
      // Replay click events to xterm only after mouseup. This keeps click-based
      // cursor positioning while preventing double-tap from entering sticky
      // word/line selection during the pressed phase.
      const target = mouseDownTarget?.isConnected ? mouseDownTarget : xtermEl;
      if (mouseDownPos.detail < 2) {
        // Single click: just position the cursor and clear any existing selection.
        // The selection was already copied when it was completed (drag/multi-click mouseup).
        replayMouseEvent(target, mouseDownPos, 'mousedown', 1);
        replayMouseEvent(target, e, 'mouseup', 0, mouseDownPos.detail);
        term.clearSelection();
      } else {
        // Double/triple click: replay to create word/line selection.
        replayMouseEvent(target, mouseDownPos, 'mousedown', 1);
        replayMouseEvent(target, e, 'mouseup', 0, mouseDownPos.detail);
        copySelectionToClipboard({ defer: true });
      }
      lastClickInfo = {
        clientX: mouseDownPos.clientX,
        clientY: mouseDownPos.clientY,
        timeStamp: e.timeStamp,
        detail: mouseDownPos.detail,
      };
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    }
    mouseDownPos = null;
    mouseDownTarget = null;
    isDragging = false;
  };

  xtermEl.addEventListener('mousedown',  mouseDownHandler,  true);
  document.addEventListener('mousemove', mouseMoveHandler,  true);
  document.addEventListener('mouseup',   mouseUpHandler,    true);

  const contextMenuHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    term.focus();
    window.runtime.ClipboardGetText()
      .then(pasteIntoTerminal)
      .catch(() => {});
  };
  xtermEl.addEventListener('contextmenu', contextMenuHandler);

  zmodem = createZmodemSentry(connID, term, (active) => {
    zmodemActive = active;
  });
  const dataHandler = (b64) => { zmodem.consume(b64); };
  on('terminal:data:' + connID, dataHandler);

  const resizeObs = new ResizeObserver(() => {
    const inst = instances[connID];
    if (!inst) return;
    if (autoFitSuspended) {
      inst.needsFitAfterSuspend = true;
      return;
    }
    const rect = visibleTerminalRect(inst);
    if (!rect) return;
    if (rect.width === inst.lastFitWidth && rect.height === inst.lastFitHeight) {
      perfLog('ResizeObserver skip unchanged size', { connID, width: rect.width, height: rect.height });
      return;
    }
    const restoreSnapshot = Date.now() - (inst._lastTabSwitch ?? 0) < 500
      ? inst.restoreSnapshot
      : null;
    scheduleTerminalFit(connID, inst, {
      restoreScroll: !!restoreSnapshot,
      snapshot: restoreSnapshot,
      caller: 'ResizeObserver',
    });
  });
  resizeObs.observe(container);

  instances[connID] = {
    term, fitAddon, resizeObs, dataHandler,
    connID,
    mouseDownHandler, mouseMoveHandler, mouseUpHandler, contextMenuHandler,
    compositionStartHandler, compositionEndHandler, beforeInputHandler, pasteHandler,
    xtermEl, fontFamily: resolvedFont, fontSize: resolvedSize,
    containerEl: container, containerId, sizeElId,
    savedViewportY: term.buffer.active.viewportY,
    savedBaseY: term.buffer.active.baseY,
    restoreSnapshot: null,
    restoreSeq: 0,
    restoreTimers: [],
    pendingFitRAF: 0,
    needsFitAfterSuspend: false,
    inputEnabled: true,
    lastFitWidth: 0,
    lastFitHeight: 0,
    disposables: [osc7Disposable, osc1337Disposable, dataDisposable, scrollDisposable],
  };

  return term;
}

export function scrollTerminalToBottom(connID) {
  const inst = instances[connID];
  if (!inst) return;
  setTimeout(() => {
    inst.term.scrollToBottom();
    const vp = inst.xtermEl.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
    rememberViewport(inst);
  }, 0);
}

export function rememberTerminalViewport(connID) {
  rememberViewport(instances[connID]);
}

export function destroyTerminal(connID) {
  const inst = instances[connID];
  if (!inst) return;
  off('terminal:data:' + connID);
  cancelPendingFit(inst);
  cancelViewportRestore(inst);
  inst.disposables?.forEach(d => d.dispose());
  inst.xtermEl.removeEventListener('compositionstart', inst.compositionStartHandler, true);
  inst.xtermEl.removeEventListener('compositionend',   inst.compositionEndHandler,   true);
  inst.xtermEl.removeEventListener('beforeinput',      inst.beforeInputHandler,      true);
  inst.xtermEl.removeEventListener('paste',            inst.pasteHandler,            true);
  inst.xtermEl.removeEventListener('mousedown',   inst.mouseDownHandler,  true);
  inst.xtermEl.removeEventListener('contextmenu', inst.contextMenuHandler);
  document.removeEventListener('mousemove',       inst.mouseMoveHandler,  true);
  document.removeEventListener('mouseup',         inst.mouseUpHandler,    true);
  inst.resizeObs.disconnect();
  try { inst.term.dispose(); } catch (e) { /* WebGL addon may throw if context already lost */ }
  delete cwdByConn[connID];
  delete instances[connID];
}

export function focusTerminal(connID) {
  instances[connID]?.term.focus();
}

export function setTerminalInputEnabled(connID, enabled) {
  const inst = instances[connID];
  if (inst) inst.inputEnabled = !!enabled;
}

export function setTerminalReconnectCallback(connID, callback) {
  const inst = instances[connID];
  if (inst) inst.reconnectCallback = callback || null;
}

export function writeTerminalLine(connID, text) {
  const term = instances[connID]?.term;
  if (!term) return;
  term.write(`\r\n${text}\r\n`);
  term.scrollToBottom();
}

// Returns the last terminal-reported CWD for connID, or null if the shell hasn't reported one.
export function getTerminalCWD(connID) {
  return instances[connID]?.cwd ?? cwdByConn[connID] ?? null;
}

export function fitTerminal(connID, { restoreScroll = false, caller = 'fitTerminal' } = {}) {
  const inst = instances[connID];
  if (!inst) return;
  fitVisibleTerminal(connID, inst, { restoreScroll, caller });
}

export function suspendTerminalAutoFit(suspended) {
  autoFitSuspended = !!suspended;
  perfLog('suspendTerminalAutoFit', { suspended: autoFitSuspended });
  if (autoFitSuspended) return;
  Object.entries(instances).forEach(([connID, inst]) => {
    if (!inst.needsFitAfterSuspend) return;
    inst.needsFitAfterSuspend = false;
    scheduleTerminalFit(connID, inst, { restoreScroll: false, caller: 'resume-auto-fit' });
  });
}

function setTerminalCWD(connID, cwd) {
  if (!cwd || !cwd.startsWith('/')) return;
  cwdByConn[connID] = cwd;
  if (instances[connID]) instances[connID].cwd = cwd;
  window.dispatchEvent(new CustomEvent('terminal:cwd:' + connID, { detail: cwd }));
}

function parseCurrentDir(data) {
  const match = data.match(/(?:^|;)CurrentDir=([^;]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function buildTheme() {
  return {
    background:    '#15151F',
    foreground:    '#FFFFFF',
    cursor:        '#F5E0DC',
    selectionBackground: 'rgba(124,140,248,0.3)',
    black:         '#14191E', brightBlack:   '#676767',
    red:           '#E04535', brightRed:     '#FF6B6B',
    green:         '#00C200', brightGreen:   '#57E690',
    yellow:        '#C7C400', brightYellow:  '#ECE100',
    blue:          '#2743C7', brightBlue:    '#A6AAF1',
    magenta:       '#BF3FBD', brightMagenta: '#E07DE0',
    cyan:          '#00C5C7', brightCyan:    '#5FFDFF',
    white:         '#C7C7C7', brightWhite:   '#FEFFFF',
  };
}
