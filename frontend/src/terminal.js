import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { sendInput, resizeTerm, on, off } from './api.js';

const isMac = navigator.platform.startsWith('Mac');
const instances = {};  // connID → { term, fitAddon, resizeObs, dataHandler, xtermEl }
const cwdByConn = {};
const DEFAULT_FONT_SIZE = 16;
const TERMINAL_DEBUG_KEY = 'ishell-terminal-debug';

function debugTerminal(...args) {
  if (localStorage.getItem(TERMINAL_DEBUG_KEY) === '1') {
    console.debug('[terminal]', ...args);
  }
}

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
        debugTerminal('sendInput', connID, payload, Array.from(new TextEncoder().encode(payload)));
        await sendInput(connID, payload);
      }
    } catch (e) {
      console.error('sendInput:', e);
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

function isGlobalAppShortcut(e) {
  if (e.type !== 'keydown') return false;
  const key = e.key.toLowerCase();
  const appMod = isMac ? (e.metaKey && !e.ctrlKey && !e.altKey) : (e.altKey && !e.ctrlKey && !e.metaKey);
  if (e.key === 'Enter' && (isMac ? e.metaKey : e.altKey)) return true;
  if (!appMod) return false;
  return key === 'w' ||
    key === 'b' ||
    key === 'f' ||
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
      container.innerHTML = '';
      container.appendChild(inst.xtermEl);
      // Defer fit to after layout; ResizeObserver won't fire if container size
      // is unchanged, so we must call resizeTerm explicitly here.
      requestAnimationFrame(() => {
        inst.fitAddon.fit();
        resizeTerm(connID, inst.term.cols, inst.term.rows).catch(() => {});
        const sizeEl = document.getElementById('sb-size');
        if (sizeEl) sizeEl.textContent = `${inst.term.cols}×${inst.term.rows}`;
      });
      return inst.term;
    }
    // Font changed: tear down old instance and fall through to rebuild.
    off('terminal:data:' + connID);
    inst.disposables?.forEach(d => d.dispose());
    inst.xtermEl.removeEventListener('compositionstart', inst.compositionStartHandler, true);
    inst.xtermEl.removeEventListener('compositionend', inst.compositionEndHandler, true);
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
    theme: buildTheme(settings?.color_scheme),
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
  let pasteFromKeyboard = false;
  let composing = false;
  let pendingComposition = null;

  const compositionStartHandler = () => {
    composing = true;
    pendingComposition = null;
    debugTerminal('compositionstart', connID);
  };

  const compositionEndHandler = (e) => {
    composing = false;
    const text = e.data || '';
    debugTerminal('compositionend', connID, text);
    if (!text) return;

    // xterm normally emits the committed IME text through onData. In Wails on
    // macOS that event can be missed, so send the composition result only if
    // xterm does not report the same text immediately after compositionend.
    const marker = { text, seenText: '' };
    pendingComposition = marker;
    setTimeout(() => {
      if (pendingComposition === marker && marker.seenText !== text) {
        debugTerminal('composition fallback', connID, text);
        flushInput(text);
      }
      if (pendingComposition === marker) pendingComposition = null;
    }, 30);
  };

  xtermEl.addEventListener('compositionstart', compositionStartHandler, true);
  xtermEl.addEventListener('compositionend', compositionEndHandler, true);

  // IME-composed text (Chinese, Japanese, etc.) should arrive here after composition ends.
  const dataDisposable = term.onData(data => {
    debugTerminal('onData', connID, data);
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
    flushInput(data);
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
      pasteFromKeyboard = true;
      window.runtime.ClipboardGetText()
        .then(text => { pasteFromKeyboard = false; if (text) flushInput(text); })
        .catch(() => { pasteFromKeyboard = false; });
      return false;
    }

    // Let xterm translate all ordinary input for the current OS, keyboard layout,
    // modifier state, and IME. The resulting bytes are sent by onData above.
    return true;
  });

  // Handles right-click "Paste" from context menu; keyboard paste is handled above.
  xtermEl.addEventListener('paste', e => {
    e.preventDefault();
    if (pasteFromKeyboard) return;
    const text = e.clipboardData?.getData('text');
    if (text) { flushInput(text); return; }
    window.runtime.ClipboardGetText()
      .then(text => { if (text) flushInput(text); })
      .catch(() => {});
  });

  // iTerm2-style selection: drag creates selection; single click just positions cursor.
  const DRAG_THRESHOLD = 4;
  let mouseDownPos = null;
  let isDragging = false;

  const mouseDownHandler = (e) => {
    if (e.button !== 0) return;
    if (e.shiftKey || e.detail >= 2) {
      // Shift+click or double/triple-click: xterm handles extend/word/line selection.
      // Mark as drag so mouseUpHandler won't clear the result.
      isDragging = true;
      return;
    }
    isDragging = false;
    mouseDownPos = { x: e.clientX, y: e.clientY };
  };

  const mouseMoveHandler = (e) => {
    if (!mouseDownPos || isDragging) return;
    const dx = e.clientX - mouseDownPos.x;
    const dy = e.clientY - mouseDownPos.y;
    if (Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) isDragging = true;
  };

  const mouseUpHandler = (e) => {
    if (e.button !== 0) return;
    if (!isDragging) {
      term.clearSelection();
    } else {
      const sel = term.getSelection();
      if (sel) window.runtime.ClipboardSetText(sel).catch(() => {});
    }
    mouseDownPos = null;
    isDragging = false;
  };

  xtermEl.addEventListener('mousedown',  mouseDownHandler,  true);
  document.addEventListener('mousemove', mouseMoveHandler,  true);
  document.addEventListener('mouseup',   mouseUpHandler,    true);

  const contextMenuHandler = (e) => {
    e.preventDefault();
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
    const el = document.getElementById('sb-size');
    if (el) el.textContent = `${term.cols}×${term.rows}`;
  });
  resizeObs.observe(container);

  instances[connID] = {
    term, fitAddon, resizeObs, dataHandler,
    mouseDownHandler, mouseMoveHandler, mouseUpHandler, contextMenuHandler,
    compositionStartHandler, compositionEndHandler,
    xtermEl, fontFamily: resolvedFont, fontSize: resolvedSize,
    disposables: [osc7Disposable, osc1337Disposable, dataDisposable],
  };

  return term;
}

export function destroyTerminal(connID) {
  const inst = instances[connID];
  if (!inst) return;
  off('terminal:data:' + connID);
  inst.disposables?.forEach(d => d.dispose());
  inst.xtermEl.removeEventListener('compositionstart', inst.compositionStartHandler, true);
  inst.xtermEl.removeEventListener('compositionend',   inst.compositionEndHandler,   true);
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
  instances[connID]?.fitAddon.fit();
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

function buildTheme(scheme) {
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
