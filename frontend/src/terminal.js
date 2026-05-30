import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { sendInput, resizeTerm, on, off } from './api.js';

// Active terminal instances keyed by connID
const instances = {};

export function createTerminal(connID, settings) {
  const container = document.getElementById('terminal-container');
  container.innerHTML = '';

  const term = new Terminal({
    fontSize: settings?.font_size || 13,
    fontFamily: settings?.font_family || "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
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
  term.open(container);
  fitAddon.fit();

  // User input → backend
  term.onData(data => {
    sendInput(connID, data).catch(console.error);
  });

  // Backend → terminal output
  const dataHandler = (b64) => {
    try {
      term.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    } catch (e) {
      console.error('terminal data decode:', e);
    }
  };
  on('terminal:data:' + connID, dataHandler);

  // Resize observer
  const resizeObs = new ResizeObserver(() => {
    fitAddon.fit();
    if (connID) {
      resizeTerm(connID, term.cols, term.rows).catch(() => {});
    }
    document.getElementById('sb-size').textContent = `${term.cols}×${term.rows}`;
  });
  resizeObs.observe(container);

  instances[connID] = { term, fitAddon, resizeObs, dataHandler };

  return term;
}

export function destroyTerminal(connID) {
  const inst = instances[connID];
  if (!inst) return;
  off('terminal:data:' + connID);
  inst.resizeObs.disconnect();
  inst.term.dispose();
  delete instances[connID];
}

export function focusTerminal(connID) {
  instances[connID]?.term.focus();
}

export function fitTerminal(connID) {
  const inst = instances[connID];
  if (!inst) return;
  inst.fitAddon.fit();
}

function buildTheme(scheme) {
  // Catppuccin Mocha (default)
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
