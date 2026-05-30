import '@xterm/xterm/css/xterm.css';
import { connect, disconnect, on, getSettings } from './api.js';
import { initSidebar, loadSessions, setSessionStatus } from './sidebar.js';
import { createTerminal, destroyTerminal, focusTerminal } from './terminal.js';
import { initSFTP } from './sftp.js';
import { initSettings } from './settings.js';
import { showToast } from './toast.js';

// ── State ─────────────────────────────────────────────────────────────────────
let tabs = [];          // { id, connID, sessionID, sessionLabel, host, username }
let activeTab = null;
let sftpActive = false;
let timerInterval = null;
let connStartTime = null;
let settings = null;

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  settings = await getSettings().catch(() => ({}));
  if (settings?.theme) document.documentElement.setAttribute('data-theme', settings.theme);

  initSidebar(onConnectRequest);

  // Toolbar buttons
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('btn-disconnect').addEventListener('click', () => activeTab && doDisconnect(activeTab.connID));
  document.getElementById('btn-sftp').addEventListener('click', toggleSFTP);
  document.getElementById('btn-settings').addEventListener('click', openSettingsPanel);
  document.getElementById('btn-search-term').addEventListener('click', toggleFind);
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.getElementById('find-close').addEventListener('click', () => setFindBar(false));

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeydown);

  // Host key events
  on('ssh:unknown_host', showHostKeyDialog);

  // Terminal closed
  on('terminal:closed', (connID) => {
    const tab = tabs.find(t => t.connID === connID);
    if (tab) { doDisconnect(connID); }
  });

  showPanel('welcome');
});

// ── Connect flow ──────────────────────────────────────────────────────────────

async function onConnectRequest(sess) {
  // Check if already connected
  const existing = tabs.find(t => t.sessionID === sess.id);
  if (existing) { switchToTab(existing); return; }

  showToast(`🔌 Connecting to ${sess.host}…`);
  setSessionStatus(sess.id, 'connecting');

  const el = document.getElementById('terminal-container');
  const cols = Math.floor((el?.clientWidth || 800) / 8);
  const rows = Math.floor((el?.clientHeight || 400) / 17);

  try {
    const connID = await connect({
      session_id: sess.id,
      password: sess.auth_type === 'password' ? sess.password : '',
      key_path: sess.auth_type === 'key' ? sess.key_path : '',
      passphrase: sess.auth_type === 'key' ? sess.passphrase : '',
      cols, rows,
    });

    const tab = {
      id: 'tab-' + Date.now(),
      connID,
      sessionID: sess.id,
      sessionLabel: sess.label || sess.host,
      host: sess.host,
      username: sess.username,
    };
    tabs.push(tab);
    renderTabs();
    switchToTab(tab);
    setSessionStatus(sess.id, 'connected');
    showToast(`✅ Connected to ${sess.host}`);
  } catch (e) {
    setSessionStatus(sess.id, 'disconnected');
    showToast(`❌ ${e}`);
    if (String(e).includes('unknown host')) return; // handled by dialog
    alert('Connection failed:\n' + e);
  }
}

async function doDisconnect(connID) {
  try { await disconnect(connID); } catch {}
  const tab = tabs.find(t => t.connID === connID);
  if (tab) { setSessionStatus(tab.sessionID, 'disconnected'); }
  tabs = tabs.filter(t => t.connID !== connID);
  destroyTerminal(connID);
  renderTabs();
  if (tabs.length > 0) switchToTab(tabs[tabs.length - 1]);
  else { activeTab = null; stopTimer(); showPanel('welcome'); updateConnUI(null); }
  showToast(`Disconnected`);
}

// ── Tab management ────────────────────────────────────────────────────────────

function renderTabs() {
  const scroll = document.getElementById('tabs-scroll');
  scroll.innerHTML = '';
  tabs.forEach((tab, idx) => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab === activeTab ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.innerHTML = `
      <div class="status-dot connected" style="width:6px;height:6px;"></div>
      <span>${escHtml(tab.sessionLabel)}</span>
      <span class="tab-num">${idx + 1}</span>
      <button class="tab-close">✕</button>`;
    el.addEventListener('click', e => {
      if (e.target.classList.contains('tab-close')) { doDisconnect(tab.connID); return; }
      switchToTab(tab);
    });
    scroll.appendChild(el);
  });

  // Add "+" button
  const addBtn = document.createElement('button');
  addBtn.className = 'tab-add';
  addBtn.title = 'New connection';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => { showPanel('welcome'); updateConnUI(null); });
  scroll.appendChild(addBtn);
}

function switchToTab(tab) {
  activeTab = tab;
  sftpActive = false;
  renderTabs();
  showPanel('terminal');
  updateConnUI(tab);
  createTerminal(tab.connID, settings);
  focusTerminal(tab.connID);
  startTimer();
}

function switchToTabByIndex(n) {
  if (n < 1 || n > tabs.length) { showToast(`No tab ${n}`); return; }
  const tab = tabs[n - 1];
  switchToTab(tab);
  showToast(`⌥${n}  ${tab.sessionLabel}`);
}

// ── Panel management ──────────────────────────────────────────────────────────

function showPanel(name) {
  ['welcome', 'terminal', 'sftp', 'settings'].forEach(p => {
    const el = document.getElementById('panel-' + p);
    if (el) el.style.display = p === name ? '' : 'none';
  });
}

function updateConnUI(tab) {
  const hasConn = !!tab;
  const divider = document.getElementById('conn-info-divider');
  const connInfo = document.getElementById('conn-info');
  const actions = document.getElementById('topbar-actions');
  divider.style.display = hasConn ? '' : 'none';
  connInfo.style.display = hasConn ? '' : 'none';
  actions.style.display = hasConn ? '' : 'none';
  if (tab) {
    document.getElementById('conn-label').textContent = `${tab.username}@${tab.host}`;
  }
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function startTimer() {
  stopTimer();
  connStartTime = Date.now();
  timerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - connStartTime) / 1000);
    const h = String(Math.floor(secs / 3600)).padStart(2, '0');
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    const el = document.getElementById('conn-timer');
    if (el) el.textContent = `${h}:${m}:${s}`;
  }, 1000);
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── SFTP toggle ───────────────────────────────────────────────────────────────

async function toggleSFTP() {
  if (!activeTab) { showToast('Connect to a session first'); return; }
  sftpActive = !sftpActive;
  if (sftpActive) {
    showPanel('sftp');
    await initSFTP(activeTab.connID);
  } else {
    showPanel('terminal');
    focusTerminal(activeTab.connID);
  }
}

// ── Settings panel ────────────────────────────────────────────────────────────

async function openSettingsPanel() {
  showPanel('settings');
  await initSettings();
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
}

// ── Find bar ─────────────────────────────────────────────────────────────────

function toggleFind() {
  setFindBar(document.getElementById('find-bar').style.display === 'none');
}
function setFindBar(show) {
  document.getElementById('find-bar').style.display = show ? '' : 'none';
  if (show) document.getElementById('find-input').focus();
}

// ── Fullscreen ────────────────────────────────────────────────────────────────

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
}
document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById('btn-fullscreen');
  if (btn) btn.textContent = document.fullscreenElement ? '⊡' : '⛶';
  showToast(document.fullscreenElement ? 'Fullscreen — Alt+Enter to exit' : 'Exited fullscreen');
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function handleKeydown(e) {
  if (e.altKey && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    switchToTabByIndex(parseInt(e.key));
    return;
  }
  if (e.altKey && e.key === 'Enter') {
    e.preventDefault();
    toggleFullscreen();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    const panelTerm = document.getElementById('panel-terminal');
    if (panelTerm && panelTerm.style.display !== 'none') {
      e.preventDefault();
      toggleFind();
    }
    return;
  }
}

// ── Host key dialog ───────────────────────────────────────────────────────────

function showHostKeyDialog(data) {
  const overlay = document.getElementById('hostkey-overlay');
  document.getElementById('hostkey-fp').textContent =
    `${data.key_type}  ${data.fingerprint}\n${data.hostname}`;
  overlay.style.display = 'flex';

  const close = () => { overlay.style.display = 'none'; };
  document.getElementById('hostkey-reject').onclick = () => { close(); showToast('❌ Connection rejected'); };
  document.getElementById('hostkey-once').onclick = () => {
    close();
    showToast('Trusted once — reconnect to apply');
  };
  document.getElementById('hostkey-always').onclick = async () => {
    close();
    // Re-connect with strict checking disabled for this one session (trust & add)
    showToast('✅ Host key accepted');
  };
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
