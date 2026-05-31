import { getSessions, deleteSession } from './api.js';
import { openProfileForm } from './profile-form.js';
import { showToast } from './toast.js';

const isWindows = navigator.platform.startsWith('Win');
const isMac = navigator.platform.startsWith('Mac');
const LOCAL_SHELL_NAME = isWindows ? 'PowerShell' : (isMac ? 'zsh' : 'bash');

export const LOCAL_SESSION = {
  type: 'local',
  id: '__local__',
  label: 'Local Terminal',
  sublabel: LOCAL_SHELL_NAME,
};

let sessions = [];
let onConnectCb = null;
let selectedProfileId = null;

export function initSidebar(onConnect) {
  onConnectCb = onConnect;
  document.getElementById('btn-new-session').addEventListener('click', () => {
    openProfileForm(null, (saved) => { loadProfiles(); });
  });
  document.getElementById('session-search').addEventListener('input', (e) => {
    renderList(e.target.value.toLowerCase());
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

function renderLocalTerminal(container) {
  const item = document.createElement('div');
  item.className = 'sidebar-item' + (selectedProfileId === '__local__' ? ' active' : '');
  item.dataset.id = '__local__';
  item.innerHTML = `
    <div class="status-dot disconnected" id="dot-__local__"></div>
    <div class="item-info">
      <div class="item-name">Local Terminal</div>
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

  // Always show local terminal at the top (not filtered)
  renderLocalTerminal(container);

  // Group sessions
  const groups = {};
  sessions.forEach(s => {
    if (filter && !matchFilter(s, filter)) return;
    const g = s.group || 'Ungrouped';
    if (!groups[g]) groups[g] = [];
    groups[g].push(s);
  });

  if (Object.keys(groups).length === 0) {
    if (filter) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:12px;color:var(--text-muted);font-size:13px;text-align:center;';
      empty.textContent = 'No matches';
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
      item.className = 'sidebar-item' + (sess.id === selectedProfileId ? ' active' : '');
      item.dataset.id = sess.id;
      item.innerHTML = `
        <div class="status-dot disconnected" id="dot-${sess.id}"></div>
        <div class="item-info">
          <div class="item-name">${escHtml(sess.label || sess.host)}</div>
          <div class="item-sub">${escHtml(sess.username)}@${escHtml(sess.host)}:${sess.port}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-ghost btn-icon btn-sm" title="Edit" data-action="edit">✏️</button>
          <button class="btn btn-ghost btn-icon btn-sm" title="Delete" data-action="delete">🗑</button>
        </div>`;

      // Single click: select profile (highlight only, no connection)
      item.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'edit') {
          openProfileForm(sess, () => loadProfiles());
          return;
        }
        if (action === 'delete') {
          if (!confirm(`Delete profile "${sess.label || sess.host}"?`)) return;
          deleteSession(sess.id).then(() => {
            if (selectedProfileId === sess.id) selectedProfileId = null;
            loadProfiles();
          }).catch(console.error);
          return;
        }
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
