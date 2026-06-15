import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { sendInput, resizeTerm, on, off } from './api.js';

const isMac = navigator.platform.startsWith('Mac');
const instances = {};  // connID → { term, fitAddon, resizeObs, dataHandler, xtermEl }
const cwdByConn = {};
const DEFAULT_FONT_SIZE = 16;

function makeInputSender(connID) {
  let pending = '';
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending) {
        const payload = pending;
        pending = '';
        try {
          await sendInput(connID, payload);
        } catch (e) {
          // Re-queue the bytes we already took so a transient IPC failure never
          // drops input, then back off briefly to avoid a busy retry loop.
          pending = payload + pending;
          console.error('sendInput:', e);
          await new Promise(r => setTimeout(r, 8));
        }
      }
    } finally {
      draining = false;
      if (pending) drain();
    }
  }

  return (data) => {
    pending += data;
    drain();
  };
}

// After a DOM re-attach the .xterm-viewport scrollTop is reset to 0 while
// xterm's internal viewportY is preserved. Re-sync the DOM to that internal
// state: if the user was following the bottom, pin to the latest output; if
// they had scrolled up to a historical line, restore that exact position.
function syncViewportScroll(inst) {
  if (!inst) return;
  const buf = inst.term.buffer.active;
  const vp = inst.xtermEl.querySelector('.xterm-viewport');
  if (!vp) return;
  if (buf.viewportY >= buf.baseY) {
    inst.term.scrollToBottom();
    vp.scrollTop = vp.scrollHeight;
  } else {
    const maxScroll = vp.scrollHeight - vp.clientHeight;
    vp.scrollTop = buf.baseY > 0 ? (buf.viewportY / buf.baseY) * maxScroll : 0;
  }
}

function isGlobalAppShortcut(e) {
  if (e.type !== 'keydown') return false;
  const key = e.key.toLowerCase();
  const appMod = isMac ? (e.metaKey && !e.ctrlKey && !e.altKey) : (e.altKey && !e.ctrlKey && !e.metaKey);
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

export function createTerminal(connID, settings) {
  const container = document.getElementById('terminal-container');

  const resolvedFont = settings?.font_family || "Menlo, Monaco, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, monospace";
  const resolvedSize = connID.startsWith('local-') ? DEFAULT_FONT_SIZE : (settings?.font_size || DEFAULT_FONT_SIZE);

  // Reuse existing terminal unless font settings changed.
  if (instances[connID]) {
    const inst = instances[connID];
    if (inst.fontFamily === resolvedFont && inst.fontSize === resolvedSize) {
      inst._lastTabSwitch = Date.now();
      container.innerHTML = '';
      container.appendChild(inst.xtermEl);
      // Defer fit to after layout; ResizeObserver won't fire if container size
      // is unchanged, so we must call resizeTerm explicitly here.
      requestAnimationFrame(() => {
        inst.fitAddon.fit();
        resizeTerm(connID, inst.term.cols, inst.term.rows).catch(() => {});
        const sizeEl = document.getElementById('sb-size');
        if (sizeEl) sizeEl.textContent = `${inst.term.cols}×${inst.term.rows}`;
        // DOM re-attach resets .xterm-viewport scrollTop to 0. Re-sync in a
        // second frame so any browser-queued scroll events fire first, then
        // restore the viewport to xterm's preserved internal scroll state
        // (bottom if following, otherwise the historical line).
        requestAnimationFrame(() => syncViewportScroll(inst));
      });
      // Belt-and-suspenders: fire after xterm's own RAF rendering pipeline to
      // cover WKWebView edge cases where the second RAF still races xterm.
      setTimeout(() => syncViewportScroll(inst), 50);
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
  term.loadAddon(new WebLinksAddon());
  term.open(xtermEl);

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

  const flushInput = makeInputSender(connID);
  let suppressPasteUntil = 0;
  let composing = false;
  let pendingComposition = null;

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
  const dataDisposable = term.onData(data => {
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

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Let xterm handle IME composition natively; onData delivers the final composed text.
    if (e.isComposing || composing || e.key === 'Process') return true;
    if (blockAppShortcut(e)) return false;

    const key = e.key.toLowerCase();

    // Any keypress while selection is active: copy selection to clipboard first.
    // Exclude modifier-only keys and the paste shortcut (which should use clipboard, not replace it).
    const isModifierOnly = ['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'CapsLock'].includes(e.key);
    const isPasteShortcut = isMac ? (e.metaKey && key === 'v') : (e.ctrlKey && e.shiftKey && key === 'v');
    if (!isModifierOnly && !isPasteShortcut) {
      const sel = term.getSelection();
      if (sel) window.runtime.ClipboardSetText(sel).catch(() => {});
    }

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
      term.clearSelection();
      window.runtime.ClipboardGetText()
        .then(text => { if (text) flushInput(text); })
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
    if (composing) return;
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
    term.clearSelection();
    if (Date.now() < suppressPasteUntil) {
      return;
    }
    const text = e.clipboardData?.getData('text');
    if (text) { flushInput(text); return; }
    window.runtime.ClipboardGetText()
      .then(text => { if (text) flushInput(text); })
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
        // Single click: if there is an existing selection, copy it before xterm clears it.
        const selBefore = term.getSelection();
        if (selBefore) copySelectionToClipboard();
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
    term.clearSelection();
    window.runtime.ClipboardGetText()
      .then(text => { if (text) flushInput(text); })
      .catch(() => {});
  };
  xtermEl.addEventListener('contextmenu', contextMenuHandler);

  const dataHandler = (b64) => {
    try {
      term.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    } catch (e) {
      console.error('terminal data decode:', e);
    }
  };
  on('terminal:data:' + connID, dataHandler);

  const resizeObs = new ResizeObserver(() => {
    fitAddon.fit();
    resizeTerm(connID, term.cols, term.rows).catch(() => {});
    // After a tab switch the container often resizes due to layout settling;
    // re-sync the viewport so the user lands back where they were (bottom if
    // following, otherwise the historical line).
    if (Date.now() - (instances[connID]?._lastTabSwitch ?? 0) < 500) {
      syncViewportScroll(instances[connID]);
    }
    const el = document.getElementById('sb-size');
    if (el) el.textContent = `${term.cols}×${term.rows}`;
  });
  resizeObs.observe(container);

  instances[connID] = {
    term, fitAddon, resizeObs, dataHandler,
    mouseDownHandler, mouseMoveHandler, mouseUpHandler, contextMenuHandler,
    compositionStartHandler, compositionEndHandler, beforeInputHandler, pasteHandler,
    xtermEl, fontFamily: resolvedFont, fontSize: resolvedSize,
    disposables: [osc7Disposable, osc1337Disposable, dataDisposable],
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
  }, 0);
}

export function destroyTerminal(connID) {
  const inst = instances[connID];
  if (!inst) return;
  off('terminal:data:' + connID);
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
  inst.term.dispose();
  delete cwdByConn[connID];
  delete instances[connID];
}

export function focusTerminal(connID) {
  instances[connID]?.term.focus();
}

// Returns the last terminal-reported CWD for connID, or null if the shell hasn't reported one.
export function getTerminalCWD(connID) {
  return instances[connID]?.cwd ?? cwdByConn[connID] ?? null;
}

export function fitTerminal(connID) {
  const inst = instances[connID];
  if (!inst) return;
  inst.fitAddon.fit();
  resizeTerm(connID, inst.term.cols, inst.term.rows).catch(() => {});
  const sizeEl = document.getElementById('sb-size');
  if (sizeEl) sizeEl.textContent = `${inst.term.cols}×${inst.term.rows}`;
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
