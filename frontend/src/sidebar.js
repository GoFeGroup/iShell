import { getSessions, deleteSession } from './api.js';
import { openSessionForm } from './session-form.js';
import { showToast } from './toast.js';

let sessions = [];
let onConnectCb = null;
let selectedProfileId = null;

export function initSidebar(onConnect) {
  onConnectCb = onConnect;
  document.getElementById('btn-new-session').addEventListener('click', () => {
    openSessionForm(null, (saved) => { loadSessions(); });
  });
  document.getElementById('session-search').addEventListener('input', (e) => {
    renderList(e.target.value.toLowerCase());
  });
  loadSessions();
}

export async function loadSessions() {
  try {
    sessions = (await getSessions()) || [];
  } catch (e) {
    console.error('loadSessions:', e);
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

function renderList(filter) {
  const container = document.getElementById('session-list');
  container.innerHTML = '';

  // Group sessions
  const groups = {};
  sessions.forEach(s => {
    if (filter && !matchFilter(s, filter)) return;
    const g = s.group || 'Ungrouped';
    if (!groups[g]) groups[g] = [];
    groups[g].push(s);
  });

  if (Object.keys(groups).length === 0) {
    container.innerHTML = `<div style="padding:20px 12px;color:var(--text-muted);font-size:13px;text-align:center;">${filter ? 'No matches' : 'No profiles yet'}</div>`;
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
          openSessionForm(sess, () => loadSessions());
          return;
        }
        if (action === 'delete') {
          if (!confirm(`Delete profile "${sess.label || sess.host}"?`)) return;
          deleteSession(sess.id).then(() => {
            if (selectedProfileId === sess.id) selectedProfileId = null;
            loadSessions();
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
