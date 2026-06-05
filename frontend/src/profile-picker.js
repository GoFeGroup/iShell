import { getSessions } from './api.js';
import { LOCAL_SESSION } from './sidebar.js';

const isMac = navigator.platform.startsWith('Mac');
let onConnectCb = null;

export function initProfilePicker(onConnect) {
  onConnectCb = onConnect;
}

export async function openProfilePicker() {
  if (document.getElementById('pp-overlay')) return;
  injectStyles();

  let sessions = [];
  try { sessions = (await getSessions()) || []; } catch {}

  const overlay = document.createElement('div');
  overlay.id = 'pp-overlay';
  overlay.className = 'pp-overlay';
  overlay.innerHTML = `
    <div class="pp-card">
      <div class="pp-search-wrap">
        <span class="pp-search-icon">🔍</span>
        <input class="pp-input" id="pp-search" placeholder="Search profiles…" autocomplete="off" spellcheck="false" />
      </div>
      <div class="pp-list" id="pp-list"></div>
    </div>`;
  document.body.appendChild(overlay);

  const searchEl = document.getElementById('pp-search');
  const listEl   = document.getElementById('pp-list');

  let items = buildItems(sessions, '');
  let selectedIdx = firstSelectableIdx(items);

  function render() {
    listEl.innerHTML = '';
    if (!items.some(i => i.kind === 'item')) {
      listEl.innerHTML = '<div class="pp-empty">No profiles found</div>';
      return;
    }
    items.forEach((item, idx) => {
      if (item.kind === 'divider') {
        const el = document.createElement('div');
        el.className = 'pp-divider';
        listEl.appendChild(el);
        return;
      }
      if (item.kind === 'group') {
        const el = document.createElement('div');
        el.className = 'pp-group';
        el.textContent = item.label;
        listEl.appendChild(el);
        return;
      }
      const { sess } = item;
      const el = document.createElement('div');
      el.className = 'pp-item' + (idx === selectedIdx ? ' selected' : '');
      el.dataset.idx = idx;
      if (item.isLocal) {
        el.innerHTML = `
          <div class="pp-item-icon">🖥</div>
          <div class="pp-item-info">
            <div class="pp-item-name">${esc(sess.label)}</div>
            <div class="pp-item-sub">${esc(sess.sublabel)}</div>
          </div>`;
      } else {
        el.innerHTML = `
          <div class="pp-item-icon">⚡</div>
          <div class="pp-item-info">
            <div class="pp-item-name">${esc(sess.label || sess.host)}</div>
            <div class="pp-item-sub">${esc(sess.username)}@${esc(sess.host)}:${sess.port}</div>
          </div>`;
      }
      el.addEventListener('click', () => doConnect(item));
      el.addEventListener('mouseenter', () => { selectedIdx = idx; render(); });
      listEl.appendChild(el);
    });
    listEl.querySelector('.pp-item.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function doConnect(item) {
    close();
    onConnectCb && onConnectCb(item.sess);
  }

  function close() {
    document.removeEventListener('keydown', docEscHandler, true);
    window.removeEventListener('ishell:nativeEsc', nativeEscHandler);
    overlay.remove();
  }

  // Non-fullscreen: DOM keydown captured before other handlers
  function docEscHandler(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  document.addEventListener('keydown', docEscHandler, true);

  // Fullscreen: native guard consumes ESC and emits this event instead of DOM keydown
  function nativeEscHandler() { close(); }
  window.addEventListener('ishell:nativeEsc', nativeEscHandler);

  function moveSelection(dir) {
    let idx = selectedIdx + dir;
    while (idx >= 0 && idx < items.length && items[idx].kind !== 'item') idx += dir;
    if (idx >= 0 && idx < items.length) { selectedIdx = idx; render(); }
  }

  searchEl.addEventListener('input', () => {
    items = buildItems(sessions, searchEl.value.toLowerCase());
    selectedIdx = firstSelectableIdx(items);
    render();
  });

  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')    { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[selectedIdx];
      if (item?.kind === 'item') doConnect(item);
    }
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  render();
  searchEl.focus();
}

function buildItems(sessions, filter) {
  const items = [];

  // Local terminal shown when no filter or when filter matches label/sublabel
  const localMatch = !filter ||
    (LOCAL_SESSION.label + ' ' + LOCAL_SESSION.sublabel).toLowerCase().includes(filter);
  if (localMatch) {
    items.push({ kind: 'item', isLocal: true, sess: LOCAL_SESSION });
    items.push({ kind: 'divider' });
  }

  const filtered = filter
    ? sessions.filter(s =>
        (s.label + s.host + s.username + (s.group || '')).toLowerCase().includes(filter))
    : sessions;

  if (filtered.length === 0) return items;

  const groups = {};
  filtered.forEach(s => {
    const g = s.group || '';
    (groups[g] = groups[g] || []).push(s);
  });

  Object.keys(groups).sort().forEach(g => {
    if (g) items.push({ kind: 'group', label: g });
    groups[g].forEach(s => items.push({ kind: 'item', isLocal: false, sess: s }));
  });

  return items;
}

function firstSelectableIdx(items) {
  return Math.max(0, items.findIndex(i => i.kind === 'item'));
}

function injectStyles() {
  if (document.getElementById('pp-styles')) return;
  const style = document.createElement('style');
  style.id = 'pp-styles';
  style.textContent = `
    .pp-overlay {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,.55); backdrop-filter: blur(4px);
      display: flex; align-items: flex-start; justify-content: center;
      padding-top: 12vh;
    }
    .pp-card {
      width: 520px; max-height: 58vh;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    .pp-search-wrap {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }
    .pp-search-icon { font-size: 16px; color: var(--text-muted); flex-shrink: 0; }
    .pp-input {
      flex: 1; border: none; background: transparent;
      font-size: 15px; color: var(--text-primary);
      font-family: var(--font-ui); outline: none;
    }
    .pp-input::placeholder { color: var(--text-muted); }
    .pp-list { flex: 1; overflow-y: auto; padding: 6px; }
    .pp-item {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 10px; border-radius: var(--radius-md);
      cursor: pointer; transition: background .08s;
    }
    .pp-item:hover, .pp-item.selected { background: var(--bg-hover); }
    .pp-item-icon { font-size: 15px; width: 22px; text-align: center; flex-shrink: 0; }
    .pp-item-info { min-width: 0; }
    .pp-item-name { font-size: 13px; color: var(--text-primary); font-weight: 500;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pp-item-sub  { font-size: 11px; color: var(--text-muted); margin-top: 1px;
                    font-family: var(--font-mono); white-space: nowrap;
                    overflow: hidden; text-overflow: ellipsis; }
    .pp-divider   { height: 1px; background: var(--border-subtle); margin: 4px 2px; }
    .pp-group     { font-size: 10px; font-weight: 700; text-transform: uppercase;
                    letter-spacing: .6px; color: var(--text-muted); padding: 8px 10px 4px; }
    .pp-empty     { padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; }
  `;
  document.head.appendChild(style);
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
