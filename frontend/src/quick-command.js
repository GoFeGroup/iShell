import { sendInput, saveSettings } from './api.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';

let settingsRef = {};
let getActiveConn = () => null;
let scrollResizeObserver = null;
let currentGroupIndex = 0;

window.addEventListener('ishell:languageChanged', () => {
  renderQuickCommands();
  updateQuickCommandUI();
});

// Built-in, position-based shortcuts: Ctrl+1..9 trigger the 1st..9th quick
// command in the currently displayed group. Same physical-key logic as before.
export function shortcutLabelForIndex(idx) {
  return 'Ctrl+' + (idx + 1);
}

function shortcutIndexFromEvent(e) {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return -1;
  const m = /^Digit([1-9])$/.exec(e.code || '');
  if (!m) return -1;
  return Number(m[1]) - 1;
}

// "\n"/"\r" submit the current line. See original file for full rationale on
// why \t/\e are deliberately not mapped and \xHH is the escape hatch.
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
    showToast(t('toast.quickCommandFailed', { e }));
  }
}

// Resolve the effective groups array.
// Supports new quick_command_groups format and falls back to legacy
// quick_commands (flat list treated as a single "Default" group).
function getGroups() {
  if (Array.isArray(settingsRef.quick_command_groups) && settingsRef.quick_command_groups.length > 0) {
    return settingsRef.quick_command_groups;
  }
  const cmds = Array.isArray(settingsRef.quick_commands)
    ? settingsRef.quick_commands.filter(c => c && c.command)
    : [];
  if (cmds.length === 0) return [];
  return [{ id: 'default', name: t('settings.quickCommands.legacyGroupName'), commands: cmds }];
}

function getCurrentGroup() {
  const groups = getGroups();
  if (groups.length === 0) return null;
  return groups[Math.min(currentGroupIndex, groups.length - 1)];
}

// Synchronous lookup so terminal.js can check "does this keystroke belong to a
// quick command" before deciding whether to forward it to the PTY as raw input.
export function findQuickCommandByShortcut(e) {
  const idx = shortcutIndexFromEvent(e);
  if (idx < 0 || !getActiveConn()) return null;
  const group = getCurrentGroup();
  if (!group) return null;
  const commands = (group.commands || []).filter(c => c && c.command);
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
  currentGroupIndex = 0;
  renderQuickCommands();
  updateQuickCommandUI();
}

export function setQuickCommandSettings(settings) {
  settingsRef = settings || {};
  currentGroupIndex = 0;
  renderQuickCommands();
  updateQuickCommandUI();
}

export function toggleQuickCommands() {
  settingsRef.show_quick_commands = settingsRef.show_quick_commands === false;
  renderQuickCommands();
  updateQuickCommandUI();
  saveSettings(settingsRef).catch(e => showToast(t('toast.qcStateSaveFailed', { e })));
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
    btn.title = visible ? t('app.hideQuickCommands') : t('app.showQuickCommands');
  }
}

function renderQuickCommands() {
  const bar = document.getElementById('quick-command-bar');
  if (!bar) return;

  const groups = getGroups();

  if (groups.length === 0) {
    bar.innerHTML = `
      <div class="quick-command-empty">${t('quickCommand.empty')}</div>
      <button class="quick-command-settings" type="button">${t('quickCommand.openSettings')}</button>`;
    bar.querySelector('.quick-command-settings')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('ishell:openSettings', { detail: { page: 'quick-commands' } }));
    });
    return;
  }

  currentGroupIndex = Math.min(currentGroupIndex, groups.length - 1);
  const group = groups[currentGroupIndex];
  const commands = (group.commands || []).filter(c => c && c.command);
  const multiGroup = groups.length > 1;

  bar.innerHTML = `
    ${multiGroup ? `
    <div class="qc-group-nav">
      <button class="qc-group-nav-btn qc-group-up" type="button" aria-label="${t('quickCommand.prevGroup')}" ${currentGroupIndex === 0 ? 'disabled' : ''}>▲</button>
      <button class="qc-group-nav-btn qc-group-down" type="button" aria-label="${t('quickCommand.nextGroup')}" ${currentGroupIndex >= groups.length - 1 ? 'disabled' : ''}>▼</button>
    </div>
    <div class="qc-bar-group-label">${escHtml(group.name || t('settings.quickCommands.groupFallback'))}</div>
    ` : ''}
    <button class="quick-command-scroll qc-scroll-left" type="button" aria-label="${t('quickCommand.scrollLeft')}">‹</button>
    <div class="quick-command-list">
      ${commands.map((cmd, i) => `
        <button class="quick-command-item${i < 9 ? ' has-shortcut' : ''}" type="button" data-id="${escAttr(cmd.id || '')}" title="${escAttr(cmd.command)}${i < 9 ? '  (' + escAttr(shortcutLabelForIndex(i)) + ')' : ''}">
          ${i < 9 ? `<span class="qc-index">${i + 1}</span>` : ''}${escHtml(cmd.label || cmd.command)}
        </button>
      `).join('')}
    </div>
    <button class="quick-command-scroll qc-scroll-right" type="button" aria-label="${t('quickCommand.scrollRight')}">›</button>`;

  bar.querySelectorAll('.quick-command-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = commands.find(c => (c.id || '') === btn.dataset.id);
      const connID = getActiveConn();
      if (!cmd || !connID) return;
      runQuickCommand(connID, cmd);
    });
  });

  if (multiGroup) {
    bar.querySelector('.qc-group-up')?.addEventListener('click', () => {
      if (currentGroupIndex > 0) { currentGroupIndex--; renderQuickCommands(); }
    });
    bar.querySelector('.qc-group-down')?.addEventListener('click', () => {
      if (currentGroupIndex < groups.length - 1) { currentGroupIndex++; renderQuickCommands(); }
    });
  }

  setupScrollControls(bar);
}

// Quick commands render as a single non-wrapping row. When there are more
// commands than fit, expose left/right scroll buttons and let a vertical
// mouse wheel scroll horizontally.
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
