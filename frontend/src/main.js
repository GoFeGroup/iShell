import '@xterm/xterm/css/xterm.css';
import { connect, connectLocal, disconnect, on, off, getSettings, sendInput } from './api.js';
import { initSidebar, loadProfiles, setSessionStatus } from './sidebar.js';
import { initProfilePicker } from './profile-picker.js';
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
let isFullscreen = false;
const pendingConnects = {}; // sessionID → { sess, req } — kept until host key dialog resolves

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  settings = await getSettings().catch(() => ({}));
  if (settings?.theme) document.documentElement.setAttribute('data-theme', settings.theme);

  if (localStorage.getItem('sidebar-collapsed') === '1') {
    const sidebar = document.getElementById('sidebar');
    sidebar.style.transition = 'none';
    sidebar.classList.add('collapsed');
    requestAnimationFrame(() => { sidebar.style.transition = ''; });
  }
  initSidebar(onConnectRequest);
  initProfilePicker(onConnectRequest);

  // Toolbar buttons
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('btn-disconnect').addEventListener('click', () => activeTab && doDisconnect(activeTab.connID));
  document.getElementById('btn-sftp').addEventListener('click', toggleSFTP);
  document.getElementById('btn-settings').addEventListener('click', openSettingsPanel);
  document.getElementById('btn-search-term').addEventListener('click', toggleFind);
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.getElementById('find-close').addEventListener('click', () => setFindBar(false));

  // Update shortcut hints based on platform
  const fsKey = isMac ? '⌘↩' : 'Alt+Enter';
  document.querySelectorAll('.kbd-hint kbd').forEach(el => {
    if (el.textContent === 'Alt+Enter') el.textContent = fsKey;
  });
  document.getElementById('btn-fullscreen').title = `Fullscreen  ${fsKey}`;
  const tabSwitchEl = document.getElementById('kbd-switch-tab');
  if (tabSwitchEl) tabSwitchEl.textContent = isMac ? '⌘1…9' : 'Alt+1…9';

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('ishell:toggleFullscreen', toggleFullscreen);
  window.addEventListener('ishell:switchTab', (e) => switchToTabByIndex(e.detail));
  window.addEventListener('ishell:closeTab', () => activeTab && doDisconnect(activeTab.connID));
  window.addEventListener('ishell:nativeEsc', handleNativeEsc);

  // Host key events
  on('ssh:unknown_host', showHostKeyDialog);

  showPanel('welcome');
});

// ── Connect flow ──────────────────────────────────────────────────────────────

async function onConnectRequest(sess) {
  if (sess.type === 'local') {
    return onLocalConnectRequest(sess);
  }
  showToast(`🔌 Connecting to ${sess.host}…`);
  setSessionStatus(sess.id, 'connecting');

  const el = document.getElementById('terminal-container');
  const cols = Math.floor((el?.clientWidth || 800) / 8);
  const rows = Math.floor((el?.clientHeight || 400) / 17);

  const req = {
    session_id: sess.id,
    password: sess.auth_type === 'password' ? sess.password : '',
    key_path: sess.auth_type === 'key' ? sess.key_path : '',
    passphrase: sess.auth_type === 'key' ? sess.passphrase : '',
    cols, rows,
  };

  // Store for potential host-key retry
  pendingConnects[sess.id] = { sess, req };

  try {
    const connID = await connect(req);
    delete pendingConnects[sess.id];
    await afterConnect(connID, sess);
  } catch (e) {
    setSessionStatus(sess.id, 'disconnected');
    if (isHostKeyPromptError(e)) return; // dialog will handle retry
    delete pendingConnects[sess.id];
    showToast(`❌ ${e}`);
    alert('Connection failed:\n' + e);
  }
}

async function onLocalConnectRequest(localSess) {
  showToast(`🖥 Opening ${localSess.sublabel}…`);
  setSessionStatus('__local__', 'connecting');

  const el = document.getElementById('terminal-container');
  const cols = Math.floor((el?.clientWidth || 800) / 8);
  const rows = Math.floor((el?.clientHeight || 400) / 17);

  try {
    const connID = await connectLocal(cols, rows);
    await afterConnect(connID, {
      id: '__local__',
      label: localSess.label,
      host: 'localhost',
      username: localSess.sublabel,
    });
    setSessionStatus('__local__', 'connected');
  } catch (e) {
    setSessionStatus('__local__', 'disconnected');
    showToast(`❌ ${e}`);
  }
}

async function afterConnect(connID, sess) {
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
  on('terminal:closed:' + connID, () => {
    if (tabs.some(t => t.connID === connID)) doDisconnect(connID);
  });
  setSessionStatus(sess.id, 'connected');
  showToast(`✅ Connected to ${sess.host}`);
}

async function doDisconnect(connID) {
  try { await disconnect(connID); } catch {}
  const tab = tabs.find(t => t.connID === connID);
  const sessionID = tab?.sessionID;
  tabs = tabs.filter(t => t.connID !== connID);
  // Only mark disconnected when no remaining tabs for this profile
  if (sessionID && !tabs.some(t => t.sessionID === sessionID)) {
    setSessionStatus(sessionID, 'disconnected');
  }
  off('terminal:closed:' + connID);
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
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('collapsed');
  localStorage.setItem('sidebar-collapsed', sidebar.classList.contains('collapsed') ? '1' : '0');
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

const isMac = navigator.platform.startsWith('Mac');

function toggleFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (isFullscreen) {
    window.runtime.WindowUnfullscreen();
    isFullscreen = false;
    if (btn) btn.textContent = '⛶';
    showToast('Exited fullscreen');
  } else {
    window.runtime.WindowFullscreen();
    isFullscreen = true;
    if (btn) btn.textContent = '⊡';
    showToast(`Fullscreen — ${isMac ? 'Cmd+Enter' : 'Alt+Enter'} to exit`);
  }
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function handleKeydown(e) {
  if ((isMac ? e.metaKey : e.altKey) && e.key === 'w') {
    e.preventDefault();
    if (activeTab) doDisconnect(activeTab.connID);
    return;
  }
  const isTabSwitch = isMac
    ? (e.metaKey && !e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9')
    : (e.altKey && !e.ctrlKey && !e.metaKey && e.key >= '1' && e.key <= '9');
  if (isTabSwitch) {
    e.preventDefault();
    switchToTabByIndex(parseInt(e.key));
    return;
  }
  if (e.key === 'Enter' && (isMac ? e.metaKey : e.altKey)) {
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

function handleNativeEsc() {
  if (!activeTab) return;
  sendInput(activeTab.connID, '\x1b').catch(e => console.error('nativeEsc sendInput:', e));
}

// ── Host key dialog ───────────────────────────────────────────────────────────

function showHostKeyDialog(data) {
  const { hostname, fingerprint, key_type, session_id } = data;

  const overlay = document.getElementById('hostkey-overlay');
  document.getElementById('hostkey-fp').textContent =
    `${key_type}  ${fingerprint}\n${hostname}`;
  overlay.style.display = 'flex';

  const close = () => { overlay.style.display = 'none'; };

  document.getElementById('hostkey-reject').onclick = () => {
    close();
    const pending = findPendingConnect(session_id, hostname);
    if (pending) delete pendingConnects[pending.sess.id];
    showToast('❌ Connection rejected');
  };

  document.getElementById('hostkey-once').onclick = async () => {
    close();
    const pending = findPendingConnect(session_id, hostname);
    if (!pending) { showToast('❌ No pending connection'); return; }
    delete pendingConnects[pending.sess.id];
    setSessionStatus(pending.sess.id, 'connecting');
    try {
      const connID = await connect({ ...pending.req, skip_host_key_check: true });
      await afterConnect(connID, pending.sess);
    } catch (e) {
      setSessionStatus(pending.sess.id, 'disconnected');
      showToast(`❌ ${e}`);
    }
  };

  document.getElementById('hostkey-always').onclick = async () => {
    close();
    const pending = findPendingConnect(session_id, hostname);
    if (!pending) { showToast('❌ No pending connection'); return; }
    delete pendingConnects[pending.sess.id];
    try {
      await window.go.main.App.AcceptHostKey(hostname);
    } catch (e) {
      showToast(`⚠️ Could not save host key: ${e}`);
    }
    setSessionStatus(pending.sess.id, 'connecting');
    try {
      const connID = await connect({ ...pending.req, skip_host_key_check: true });
      await afterConnect(connID, pending.sess);
    } catch (e) {
      setSessionStatus(pending.sess.id, 'disconnected');
      showToast(`❌ ${e}`);
    }
  };
}

function findPendingConnect(sessionID, hostname) {
  if (sessionID && pendingConnects[sessionID]) return pendingConnects[sessionID];

  return Object.values(pendingConnects).find(({ sess }) => {
    const port = sess.port || 22;
    return hostname === `${sess.host}:${port}` || hostname === sess.host;
  });
}

function isHostKeyPromptError(err) {
  const message = String(err).toLowerCase();
  return message.includes('unknown host') ||
    message.includes('knownhosts') ||
    message.includes('key is unknown') ||
    message.includes('host key');
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
