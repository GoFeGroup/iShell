import { sendInput, saveSettings } from './api.js';
import { showToast } from './toast.js';

let settingsRef = {};
let getActiveConn = () => null;
let scrollResizeObserver = null;

// Built-in, position-based shortcuts: Ctrl+1..9 (same on every platform) trigger
// the 1st..9th quick command in the list. Plain Ctrl+digit (no Shift/Alt/Meta)
// isn't claimed by readline/shell control characters (those are Ctrl+letter) or
// by this app's other shortcuts (Cmd/Alt+1..9 for tab-switching, Ctrl+Shift+C/V
// for copy/paste), and sidesteps Cmd/Alt+Shift+digit combos which on some
// keyboards/macOS setups got reported with a mangled digit and a phantom
// Ctrl modifier (likely interference from another app or keyboard rollover).
export function shortcutLabelForIndex(idx) {
  return 'Ctrl+' + (idx + 1);
}

function shortcutIndexFromEvent(e) {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return -1;
  // Use e.code (physical key, e.g. "Digit1"), not e.key, so this is unaffected
  // by keyboard layout or any modifier-driven symbol shifting.
  const m = /^Digit([1-9])$/.exec(e.code || '');
  if (!m) return -1;
  return Number(m[1]) - 1;
}

// "\n"/"\r" both submit the current line — canonical-mode PTYs and shell
// readline alike treat LF/CR as "accept line", matching the echo -e/printf
// convention for "\n". Deliberately NOT mapping "\t"/"\e" to raw bytes:
// verified empirically that an interactive shell's readline intercepts a
// literal Tab to trigger completion (silently dropping it, and sometimes
// mangling the rest of the line) and a literal ESC to start a Meta-key
// combo with whatever character follows it (e.g. ESC+w deletes a word) —
// neither behaves like "insert this character". Power users who really
// want a raw Tab/ESC byte despite that caveat can still reach for \x09 /
// \x1b explicitly. Unknown "\X" sequences are left untouched, backslash
// included, so things like Windows paths or shell metachars ("\$", "\ ")
// typed into a command aren't mangled.
function unescapeCommand(text) {
  return text.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (match, esc) => {
    if (esc.length === 3 && esc[0] === 'x') {
      return String.fromCharCode(parseInt(esc.slice(1), 16));
    }
    switch (esc) {
      case 'n': return '\n';
      case 'r': return '\r';
      case '\\': return '\\';
      default: return match;
    }
  });
}

async function runQuickCommand(connID, cmd) {
  try {
    await sendInput(connID, unescapeCommand(String(cmd.command || '')));
  } catch (e) {
    showToast('Quick command failed: ' + e);
  }
}

// Synchronous lookup so terminal.js can check "does this keystroke belong to a
// quick command" before deciding whether to forward it to the PTY as raw input.
export function findQuickCommandByShortcut(e) {
  const idx = shortcutIndexFromEvent(e);
  if (idx < 0 || !getActiveConn()) return null;
  const commands = Array.isArray(settingsRef.quick_commands) ? settingsRef.quick_commands.filter(c => c && c.command) : [];
  return commands[idx] || null;
}

// Called from main.js's global keydown handler. Returns true (and sends the
// command) if the event matches a configured quick-command shortcut.
export function triggerQuickCommandShortcut(e) {
  const cmd = findQuickCommandByShortcut(e);
  if (!cmd) return false;
  e.preventDefault();
  runQuickCommand(getActiveConn(), cmd);
  return true;
}

export function initQuickCommands(settings, activeConnGetter) {
  settingsRef = settings || {};
  getActiveConn = activeConnGetter || getActiveConn;
  renderQuickCommands();
  updateQuickCommandUI();
}

export function setQuickCommandSettings(settings) {
  settingsRef = settings || {};
  renderQuickCommands();
  updateQuickCommandUI();
}

export function toggleQuickCommands() {
  settingsRef.show_quick_commands = settingsRef.show_quick_commands === false;
  renderQuickCommands();
  updateQuickCommandUI();
  saveSettings(settingsRef).catch(e => showToast('Could not save quick command state: ' + e));
}

export function updateQuickCommandUI() {
  const bar = document.getElementById('quick-command-bar');
  const btn = document.getElementById('btn-quick-command');
  const hasConn = !!getActiveConn();
  const visible = settingsRef.show_quick_commands !== false && hasConn;
  if (bar) bar.style.display = visible ? '' : 'none';
  if (btn) {
    btn.style.display = hasConn ? '' : 'none';
    btn.classList.toggle('active', visible);
    btn.title = visible ? 'Hide quick commands' : 'Show quick commands';
  }
}

function renderQuickCommands() {
  const bar = document.getElementById('quick-command-bar');
  if (!bar) return;

  const commands = Array.isArray(settingsRef.quick_commands)
    ? settingsRef.quick_commands.filter(c => c && c.command)
    : [];

  if (commands.length === 0) {
    bar.innerHTML = `
      <div class="quick-command-empty">No quick commands</div>
      <button class="quick-command-settings" type="button">Open Settings</button>`;
    bar.querySelector('.quick-command-settings')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('ishell:openSettings', { detail: { page: 'quick-commands' } }));
    });
    return;
  }

  bar.innerHTML = `
    <button class="quick-command-scroll qc-scroll-left" type="button" aria-label="Scroll left">‹</button>
    <div class="quick-command-list">
      ${commands.map((cmd, i) => `
        <button class="quick-command-item${i < 9 ? ' has-shortcut' : ''}" type="button" data-id="${escAttr(cmd.id || '')}" title="${escAttr(cmd.command)}${i < 9 ? '  (' + escAttr(shortcutLabelForIndex(i)) + ')' : ''}">
          ${i < 9 ? `<span class="qc-index">${i + 1}</span>` : ''}${escHtml(cmd.label || cmd.command)}
        </button>
      `).join('')}
    </div>
    <button class="quick-command-scroll qc-scroll-right" type="button" aria-label="Scroll right">›</button>`;

  bar.querySelectorAll('.quick-command-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = commands.find(c => (c.id || '') === btn.dataset.id);
      const connID = getActiveConn();
      if (!cmd || !connID) return;
      runQuickCommand(connID, cmd);
    });
  });

  setupScrollControls(bar);
}

// Quick commands render as a single non-wrapping row (the bar's height must
// stay fixed so it doesn't eat into the terminal area). When there are more
// commands than fit, expose left/right buttons and let a plain vertical
// mouse wheel scroll the row horizontally — a trackpad can already swipe
// sideways, but a normal wheel can't without this.
function setupScrollControls(bar) {
  const list = bar.querySelector('.quick-command-list');
  const leftBtn = bar.querySelector('.qc-scroll-left');
  const rightBtn = bar.querySelector('.qc-scroll-right');
  if (scrollResizeObserver) scrollResizeObserver.disconnect();
  if (!list || !leftBtn || !rightBtn) return;

  const update = () => {
    const overflowing = list.scrollWidth > list.clientWidth + 1;
    leftBtn.classList.toggle('visible', overflowing);
    rightBtn.classList.toggle('visible', overflowing);
    leftBtn.disabled = list.scrollLeft <= 0;
    rightBtn.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
  };

  leftBtn.addEventListener('click', () => list.scrollBy({ left: -list.clientWidth * 0.8, behavior: 'smooth' }));
  rightBtn.addEventListener('click', () => list.scrollBy({ left: list.clientWidth * 0.8, behavior: 'smooth' }));
  list.addEventListener('scroll', update);
  list.addEventListener('wheel', e => {
    if (!e.deltaY) return;
    list.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  scrollResizeObserver = new ResizeObserver(update);
  scrollResizeObserver.observe(list);
  update();
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
}
