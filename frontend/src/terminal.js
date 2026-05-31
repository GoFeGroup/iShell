import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { sendInput, resizeTerm, on, off } from './api.js';

const isMac = navigator.platform.startsWith('Mac');
const instances = {};  // connID → { term, fitAddon, resizeObs, dataHandler, xtermEl }
const INPUT_BATCH_DELAY_MS = 60;

function makeInputSender(connID) {
  let buffer = '';
  let timer = null;
  let chain = Promise.resolve();

  function send(payload) {
    chain = chain
      .then(() => sendInput(connID, payload))
      .catch(e => console.error('sendInput:', e));
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buffer) return;
    const payload = buffer;
    buffer = '';
    send(payload);
  }

  return (data) => {
    buffer += data;
    if (shouldFlushInput(data)) {
      flush();
      return;
    }
    if (!timer) timer = setTimeout(flush, INPUT_BATCH_DELAY_MS);
  };
}

function shouldFlushInput(data) {
  return data.length > 1 ||
    data === '\r' ||
    data === '\n' ||
    data === '\t' ||
    data === '\x7f' ||
    data === '\x1b';
}

function isPlainPrintableKey(e) {
  return e.type === 'keydown' &&
    e.key.length === 1 &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey;
}

function keyEventToInput(e) {
  if (e.type !== 'keydown' || e.metaKey) return null;
  if (e.altKey && e.key.length === 1 && !e.ctrlKey) return '\x1b' + e.key;
  if (e.ctrlKey && e.key.length === 1) {
    const ch = e.key.toUpperCase().charCodeAt(0);
    if (ch >= 64 && ch <= 95) return String.fromCharCode(ch - 64);
  }
  if (isPlainPrintableKey(e)) return e.key;

  switch (e.key) {
    case 'Enter': return '\r';
    case 'Backspace': return '\x7f';
    case 'Escape': return '\x1b';
    case 'ArrowUp': return '\x1b[A';
    case 'ArrowDown': return '\x1b[B';
    case 'ArrowRight': return '\x1b[C';
    case 'ArrowLeft': return '\x1b[D';
    case 'Home': return '\x1b[H';
    case 'End': return '\x1b[F';
    case 'Delete': return '\x1b[3~';
    case 'PageUp': return '\x1b[5~';
    case 'PageDown': return '\x1b[6~';
    default: return null;
  }
}

export function createTerminal(connID, settings) {
  const container = document.getElementById('terminal-container');

  const resolvedFont = settings?.font_family || "Menlo, Monaco, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, monospace";
  const resolvedSize = settings?.font_size || 16;

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
  fitAddon.fit();
  // Sync initial PTY size immediately; ResizeObserver handles subsequent resizes.
  resizeTerm(connID, term.cols, term.rows).catch(() => {});

  const flushInput = makeInputSender(connID);
  let pasteFromKeyboard = false;

  const tabHandler = (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    flushInput('\t');
  };
  xtermEl.addEventListener('keydown', tabHandler, true);

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;

    if (e.key === 'Enter' && (isMac ? e.metaKey : e.altKey)) {
      window.dispatchEvent(new CustomEvent('ishell:toggleFullscreen'));
      return false;
    }

    // Close current tab: Cmd+W (Mac) or Alt+W (Win/Linux)
    if (isMac ? (e.metaKey && e.key === 'w') : (e.altKey && e.key === 'w')) {
      window.dispatchEvent(new CustomEvent('ishell:closeTab'));
      return false;
    }

    // Tab switching: Cmd+1-9 (Mac) or Alt+1-9 (Win/Linux)
    const isTabSwitch = isMac
      ? (e.metaKey && !e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9')
      : (e.altKey && !e.ctrlKey && !e.metaKey && e.key >= '1' && e.key <= '9');
    if (isTabSwitch) {
      window.dispatchEvent(new CustomEvent('ishell:switchTab', { detail: parseInt(e.key) }));
      return false;
    }

    // Copy: Cmd+C (Mac) or Ctrl+Shift+C (Win/Linux)
    if (isMac ? (e.metaKey && e.key === 'c') : (e.ctrlKey && e.shiftKey && e.key === 'C')) {
      const sel = term.getSelection();
      if (sel) window.runtime.ClipboardSetText(sel).catch(() => {});
      return false;
    }

    // Paste: Cmd+V (Mac) or Ctrl+Shift+V (Win/Linux)
    if (isMac ? (e.metaKey && e.key === 'v') : (e.ctrlKey && e.shiftKey && e.key === 'V')) {
      pasteFromKeyboard = true;
      window.runtime.ClipboardGetText()
        .then(text => { pasteFromKeyboard = false; if (text) flushInput(text); })
        .catch(() => { pasteFromKeyboard = false; });
      return false;
    }

    const input = keyEventToInput(e);
    if (input) {
      flushInput(input);
      return false;
    }
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
    term, fitAddon, resizeObs, dataHandler, tabHandler,
    mouseDownHandler, mouseMoveHandler, mouseUpHandler, contextMenuHandler,
    xtermEl, fontFamily: resolvedFont, fontSize: resolvedSize,
  };

  return term;
}

export function destroyTerminal(connID) {
  const inst = instances[connID];
  if (!inst) return;
  off('terminal:data:' + connID);
  inst.xtermEl.removeEventListener('keydown',     inst.tabHandler,        true);
  inst.xtermEl.removeEventListener('mousedown',   inst.mouseDownHandler,  true);
  inst.xtermEl.removeEventListener('contextmenu', inst.contextMenuHandler);
  document.removeEventListener('mousemove',       inst.mouseMoveHandler,  true);
  document.removeEventListener('mouseup',         inst.mouseUpHandler,    true);
  inst.resizeObs.disconnect();
  inst.term.dispose();
  delete instances[connID];
}

export function focusTerminal(connID) {
  instances[connID]?.term.focus();
}

export function fitTerminal(connID) {
  instances[connID]?.fitAddon.fit();
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
