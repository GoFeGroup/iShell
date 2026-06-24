import { getSessions, deleteSession } from './api.js';
import { openProfileForm } from './profile-form.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';

const isWindows = navigator.platform.startsWith('Win');
const isMac = navigator.platform.startsWith('Mac');
const LOCAL_SHELL_NAME = isWindows ? 'PowerShell' : (isMac ? 'zsh' : 'bash');

export const LOCAL_SESSION = {
  type: 'local',
  id: '__local__',
  get label() { return t('sidebar.localTerminal'); },
  sublabel: LOCAL_SHELL_NAME,
};

let sessions = [];
let onConnectCb = null;
let selectedProfileId = null;
let searchHighlightId = null;
// ID of the session row currently armed for delete (showing inline
// Delete/Cancel in place of its edit/delete icons) — mirrors
// ai-sidebar.js's inline-confirm pattern instead of window.confirm(),
// which this app's webview does not reliably support.
let confirmingDeleteID = null;

export function initSidebar(onConnect) {
  onConnectCb = onConnect;
  document.getElementById('btn-new-session').addEventListener('click', () => {
    openProfileForm(null, (saved) => { loadProfiles(); });
  });
  const searchEl = document.getElementById('session-search');
  searchEl.addEventListener('input', (e) => {
    renderList(e.target.value.toLowerCase());
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !searchHighlightId) return;
    e.preventDefault();
    const id = searchHighlightId;
    searchEl.value = '';
    renderList('');
    if (id === '__local__') {
      onConnectCb && onConnectCb(LOCAL_SESSION);
    } else {
      const sess = sessions.find(s => s.id === id);
      if (sess) onConnectCb && onConnectCb(sess);
    }
  });
  loadProfiles();
}

export async function loadProfiles() {
  try {
    sessions = (await getSessions()) || [];
  } catch (e) {
    console.error('loadProfiles:', e);
    sessions = [];
  }
  renderList('');
}

function setSelectedProfile(id) {
  selectedProfileId = id;
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.id === id);
  });
}

function renderLocalTerminal(container, activeId) {
  const item = document.createElement('div');
  item.className = 'sidebar-item' + (activeId === '__local__' ? ' active' : '');
  item.dataset.id = '__local__';
  item.innerHTML = `
    <div class="status-dot disconnected" id="dot-__local__"></div>
    <div class="item-info">
      <div class="item-name">${t('sidebar.localTerminal')}</div>
      <div class="item-sub">${LOCAL_SHELL_NAME}</div>
    </div>`;

  item.addEventListener('click', () => setSelectedProfile('__local__'));
  item.addEventListener('dblclick', () => onConnectCb && onConnectCb(LOCAL_SESSION));

  container.appendChild(item);

  const divider = document.createElement('div');
  divider.className = 'divider';
  container.appendChild(divider);
}

function renderList(filter) {
  const container = document.getElementById('session-list');
  container.innerHTML = '';

  const localMatch = !filter ||
    (t('sidebar.localTerminal') + ' ' + LOCAL_SHELL_NAME).toLowerCase().includes(filter);
  const filteredSessions = filter
    ? sessions.filter(s => matchFilter(s, filter))
    : sessions;

  // During search: highlight the first match; otherwise keep user's selection
  let activeId = selectedProfileId;
  if (filter) {
    if (localMatch) activeId = '__local__';
    else if (filteredSessions.length > 0) activeId = filteredSessions[0].id;
    else activeId = null;
    searchHighlightId = activeId;
  } else {
    searchHighlightId = null;
  }

  if (localMatch) renderLocalTerminal(container, activeId);

  // Group sessions
  const groups = {};
  filteredSessions.forEach(s => {
    const g = s.group || t('sidebar.ungrouped');
    if (!groups[g]) groups[g] = [];
    groups[g].push(s);
  });

  if (Object.keys(groups).length === 0) {
    if (filter && !localMatch) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:12px;color:var(--text-muted);font-size:13px;text-align:center;';
      empty.textContent = t('sidebar.noMatches');
      container.appendChild(empty);
    }
    return;
  }

  Object.keys(groups).sort().forEach(g => {
    // Group header
    const hdr = document.createElement('div');
    hdr.className = 'section-header';
    hdr.innerHTML = `<span>${escHtml(g)}</span>`;
    container.appendChild(hdr);

    groups[g].forEach(sess => {
      const item = document.createElement('div');
      item.className = 'sidebar-item' + (sess.id === activeId ? ' active' : '');
      item.dataset.id = sess.id;
      const confirmingDelete = confirmingDeleteID === sess.id;
      item.innerHTML = `
        <div class="status-dot disconnected" id="dot-${sess.id}"></div>
        <div class="item-info">
          <div class="item-name">${escHtml(sess.label || sess.host)}</div>
          <div class="item-sub">${escHtml(sess.username)}@${escHtml(sess.host)}:${sess.port}</div>
        </div>
        <div class="item-actions${confirmingDelete ? ' confirming' : ''}">
          ${confirmingDelete ? `
            <span class="ai-confirm-label">${t('sidebar.confirmDelete', { label: sess.label || sess.host })}</span>
            <button class="btn btn-danger btn-sm" data-action="confirm-delete">${t('common.delete')}</button>
            <button class="btn btn-ghost btn-sm" data-action="cancel-delete">${t('common.cancel')}</button>
          ` : `
            <button class="btn btn-ghost btn-icon btn-sm" title="${t('common.edit')}" data-action="edit">✏️</button>
            <button class="btn btn-ghost btn-icon btn-sm" title="${t('common.delete')}" data-action="delete">🗑</button>
          `}
        </div>`;

      // Single click: select profile (highlight only, no connection)
      item.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'edit') {
          openProfileForm(sess, () => loadProfiles());
          return;
        }
        if (action === 'delete') {
          confirmingDeleteID = sess.id;
          renderList(filter);
          return;
        }
        if (action === 'confirm-delete') {
          confirmingDeleteID = null;
          deleteSession(sess.id).then(() => {
            if (selectedProfileId === sess.id) selectedProfileId = null;
            loadProfiles();
          }).catch(console.error);
          return;
        }
        if (action === 'cancel-delete') {
          confirmingDeleteID = null;
          renderList(filter);
          return;
        }
        if (confirmingDelete) return; // row armed for delete; don't also select it
        setSelectedProfile(sess.id);
      });

      // Double click: connect and open a new terminal tab
      item.addEventListener('dblclick', (e) => {
        if (e.target.closest('[data-action]')) return;
        onConnectCb && onConnectCb(sess);
      });

      container.appendChild(item);
    });

    const div = document.createElement('div');
    div.className = 'divider';
    container.appendChild(div);
  });

  // Scroll first match into view when searching
  if (filter && activeId) {
    container.querySelector(`.sidebar-item[data-id="${activeId}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
}

function matchFilter(s, f) {
  return (s.label + s.host + s.username + s.group).toLowerCase().includes(f);
}

export function setSessionStatus(sessionId, status) {
  // status: 'connected' | 'connecting' | 'disconnected'
  document.querySelectorAll(`.sidebar-item[data-id="${sessionId}"] .status-dot`).forEach(dot => {
    dot.className = `status-dot ${status}`;
  });
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
