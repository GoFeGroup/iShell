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
  const resolvedSize = settings?.font_size || 13;

  // Reuse existing terminal unless font settings changed.
  if (instances[connID]) {
    const inst = instances[connID];
    if (inst.fontFamily === resolvedFont && inst.fontSize === resolvedSize) {
      container.innerHTML = '';
      container.appendChild(inst.xtermEl);
      inst.fitAddon.fit();
      return inst.term;
    }
    // Font changed: tear down old instance and fall through to rebuild.
    off('terminal:data:' + connID);
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

    // Alt+1-9: tab switching (intercept before keyEventToInput sends escape sequence to SSH)
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key >= '1' && e.key <= '9') {
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

  instances[connID] = { term, fitAddon, resizeObs, dataHandler, tabHandler, xtermEl, fontFamily: resolvedFont, fontSize: resolvedSize };

  return term;
}

export function destroyTerminal(connID) {
  const inst = instances[connID];
  if (!inst) return;
  off('terminal:data:' + connID);
  inst.xtermEl.removeEventListener('keydown', inst.tabHandler, true);
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
    background:    '#0D0D13',
    foreground:    '#CDD6F4',
    cursor:        '#F5E0DC',
    selectionBackground: 'rgba(124,140,248,0.3)',
    black:         '#45475A', brightBlack:   '#585B70',
    red:           '#F38BA8', brightRed:     '#F38BA8',
    green:         '#A6E3A1', brightGreen:   '#A6E3A1',
    yellow:        '#F9E2AF', brightYellow:  '#F9E2AF',
    blue:          '#89B4FA', brightBlue:    '#89B4FA',
    magenta:       '#CBA6F7', brightMagenta: '#CBA6F7',
    cyan:          '#94E2D5', brightCyan:    '#94E2D5',
    white:         '#BAC2DE', brightWhite:   '#A6ADC8',
  };
}
