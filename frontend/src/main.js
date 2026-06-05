import '@xterm/xterm/css/xterm.css';
import { acceptHostKey, connect, connectLocal, disconnect, focusWindow, on, off, getSettings, sendInput, launchNewInstance } from './api.js';
import { initSidebar, loadProfiles, setSessionStatus, LOCAL_SESSION } from './sidebar.js';
import { initProfilePicker, openProfilePicker } from './profile-picker.js';
import { createTerminal, destroyTerminal, focusTerminal, fitTerminal } from './terminal.js';
import { initSFTP } from './sftp.js';
import { initSettings } from './settings.js';
import { showToast } from './toast.js';

// ── State ─────────────────────────────────────────────────────────────────────
let tabs = [];          // terminal: { type, id, connID, sessionID, sessionLabel, host, username }; settings: { type, id, sessionLabel }
let activeTab = null;
let sftpActive = false;
let settings = null;
let isFullscreen = false;
const pendingConnects = {}; // sessionID → { sess, req } — kept until host key dialog resolves

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  // Bring window to front on startup; works around Windows foreground-steal restriction.
  focusWindow().catch(() => {});

  settings = await getSettings().catch(() => ({}));
  if (settings?.theme) {
    document.documentElement.setAttribute('data-theme', settings.theme);
    localStorage.setItem('theme', settings.theme);
  }

  initSidebar(onConnectRequest);
  initProfilePicker(onConnectRequest);

  // Toolbar buttons
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('btn-disconnect').addEventListener('click', () => isTerminalTab(activeTab) && doDisconnect(activeTab.connID));
  document.getElementById('btn-sftp').addEventListener('click', toggleSFTP);
  document.getElementById('btn-settings').addEventListener('click', openSettingsPanel);
  document.getElementById('btn-new-instance').addEventListener('click', openNewInstance);
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
  document.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('ishell:toggleFullscreen', toggleFullscreen);
  window.addEventListener('ishell:toggleSidebar', toggleSidebar);
  window.addEventListener('ishell:toggleFind', toggleFind);
  window.addEventListener('ishell:switchTab', (e) => switchToTabByIndex(e.detail));
  window.addEventListener('ishell:closeTab', () => closeTab(activeTab));
  window.addEventListener('ishell:closeSettings', closeSettingsTab);
  window.addEventListener('ishell:nativeEsc', handleNativeEsc);

  // Host key events
  on('ssh:unknown_host', showHostKeyDialog);

  showPanel('welcome');
});

async function openNewInstance() {
  try {
    await launchNewInstance();
  } catch (e) {
    showToast(`❌ ${e}`);
  }
}

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
    type: 'terminal',
    id: 'tab-' + Date.now(),
    connID,
    sessionID: sess.id,
    sessionLabel: sess.label || sess.host,
    host: sess.host,
    username: sess.username,
    isLocal: sess.id === '__local__',
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
  const closedIndex = tabs.indexOf(tab);
  const wasActive = tab === activeTab;
  const sessionID = tab?.sessionID;
  tabs = tabs.filter(t => t.connID !== connID);
  // Only mark disconnected when no remaining tabs for this profile
  if (sessionID && !tabs.some(t => t.sessionID === sessionID)) {
    setSessionStatus(sessionID, 'disconnected');
  }
  off('terminal:closed:' + connID);
  destroyTerminal(connID);
  renderTabs();
  if (wasActive) activateFallbackTab(closedIndex);
  else if (activeTab) updateConnUI(isTerminalTab(activeTab) ? activeTab : null);
  else showWelcome();
  showToast(`Disconnected`);
}

// ── Tab management ────────────────────────────────────────────────────────────

function renderTabs() {
  const scroll = document.getElementById('tabs-scroll');
  scroll.innerHTML = '';
  tabs.forEach((tab, idx) => {
    const isSettings = tab.type === 'settings';
    const el = document.createElement('div');
    el.className = 'tab' + (tab === activeTab ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.innerHTML = `
      ${isSettings ? '<span class="tab-icon">⚙</span>' : '<div class="status-dot connected" style="width:6px;height:6px;"></div>'}
      <span>${escHtml(tab.sessionLabel)}</span>
      <span class="tab-num">${idx + 1}</span>
      <button class="tab-close">✕</button>`;
    el.addEventListener('click', e => {
      if (e.target.classList.contains('tab-close')) { closeTab(tab); return; }
      switchToTab(tab);
    });
    scroll.appendChild(el);
  });

  // Add "+" button
  const addBtn = document.createElement('button');
  addBtn.className = 'tab-add';
  addBtn.title = 'New connection';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', showWelcome);
  scroll.appendChild(addBtn);
}

async function switchToTab(tab) {
  if (!tab) return;
  if (tab.type === 'settings') {
    activeTab = tab;
    sftpActive = false;
    renderTabs();
    showPanel('settings');
    updateConnUI(null);
    await initSettings();
    return;
  }
  activeTab = tab;
  sftpActive = false;
  renderTabs();
  showPanel('terminal');
  updateConnUI(tab);
  createTerminal(tab.connID, settings);
  refitActiveTerminal();
  focusTerminal(tab.connID);
}

function switchToTabByIndex(n) {
  if (n < 1 || n > tabs.length) { showToast(`No tab ${n}`); return; }
  const tab = tabs[n - 1];
  switchToTab(tab);
  showToast(`${isMac ? '⌘' : '⌥'}${n}  ${tab.sessionLabel}`);
}

function closeTab(tab) {
  if (!tab) return;
  if (tab.type === 'settings') {
    closeSettingsTab();
    return;
  }
  if (isTerminalTab(tab)) doDisconnect(tab.connID);
}

function closeSettingsTab() {
  const tab = tabs.find(t => t.type === 'settings');
  if (!tab) return;
  const closedIndex = tabs.indexOf(tab);
  const wasActive = tab === activeTab;
  tabs = tabs.filter(t => t !== tab);
  renderTabs();
  if (wasActive) activateFallbackTab(closedIndex);
}

function activateFallbackTab(closedIndex) {
  if (tabs.length > 0) {
    switchToTab(tabs[Math.min(closedIndex, tabs.length - 1)]);
  } else {
    showWelcome();
  }
}

function showWelcome() {
  activeTab = null;
  sftpActive = false;
  renderTabs();
  showPanel('welcome');
  updateConnUI(null);
}

function isTerminalTab(tab) {
  return !!tab && tab.type !== 'settings' && !!tab.connID;
}

// ── Panel management ──────────────────────────────────────────────────────────

function showPanel(name) {
  ['welcome', 'terminal', 'sftp', 'settings'].forEach(p => {
    const el = document.getElementById('panel-' + p);
    if (el) el.style.display = p === name ? '' : 'none';
  });
}

function refitActiveTerminal() {
  if (!isTerminalTab(activeTab)) return;
  requestAnimationFrame(() => {
    if (!isTerminalTab(activeTab)) return;
    if (document.getElementById('panel-terminal')?.style.display === 'none') return;
    fitTerminal(activeTab.connID);
  });
}

function refitActiveTerminalAfterLayout() {
  refitActiveTerminal();
  setTimeout(refitActiveTerminal, 260);
}

function updateConnUI(tab) {
  const hasConn = !!tab;
  const actions = document.getElementById('topbar-actions');
  const sftpBtn = document.getElementById('btn-sftp');
  actions.style.display = hasConn ? '' : 'none';
  if (sftpBtn) sftpBtn.style.display = hasConn && !tab?.isLocal ? '' : 'none';
}

// ── SFTP toggle ───────────────────────────────────────────────────────────────

async function toggleSFTP() {
  if (!isTerminalTab(activeTab)) { showToast('Connect to a session first'); return; }
  if (activeTab.isLocal) { showToast('SFTP is only available for remote SSH sessions'); return; }
  sftpActive = !sftpActive;
  if (sftpActive) {
    showPanel('sftp');
    await initSFTP(activeTab.connID);
  } else {
    showPanel('terminal');
    refitActiveTerminal();
    focusTerminal(activeTab.connID);
  }
}

// ── Settings panel ────────────────────────────────────────────────────────────

async function openSettingsPanel() {
  let tab = tabs.find(t => t.type === 'settings');
  if (!tab) {
    tab = {
      type: 'settings',
      id: 'tab-settings',
      sessionLabel: 'Settings',
    };
    tabs.push(tab);
  }
  await switchToTab(tab);
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const collapsed = !document.documentElement.classList.contains('sidebar-collapsed');
  sidebar.classList.toggle('collapsed', collapsed);
  document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '0');
  refitActiveTerminalAfterLayout();
}

// ── Find bar ─────────────────────────────────────────────────────────────────

function toggleFind() {
  setFindBar(document.getElementById('find-bar').style.display === 'none');
}
function setFindBar(show) {
  document.getElementById('find-bar').style.display = show ? '' : 'none';
  if (show) document.getElementById('find-input').focus();
  refitActiveTerminal();
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
  refitActiveTerminalAfterLayout();
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function handleKeydown(e) {
  if ((isMac ? e.metaKey : e.altKey) && e.key === 'w') {
    e.preventDefault();
    closeTab(activeTab);
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
  if ((isMac ? e.metaKey : e.altKey) && e.key.toLowerCase() === 't') {
    e.preventDefault();
    onLocalConnectRequest(LOCAL_SESSION);
    return;
  }
  if ((isMac ? e.metaKey : e.altKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    openProfilePicker();
    return;
  }
  if (e.key === 'Enter' && (isMac ? e.metaKey : e.altKey)) {
    e.preventDefault();
    toggleFullscreen();
    return;
  }
  if ((isMac ? e.metaKey : e.altKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  if ((isMac ? e.metaKey : e.altKey) && e.key.toLowerCase() === 'f') {
    const panelTerm = document.getElementById('panel-terminal');
    if (panelTerm && panelTerm.style.display !== 'none') {
      e.preventDefault();
      toggleFind();
    }
    return;
  }
  if ((isMac ? e.metaKey : e.altKey) && e.key === ',') {
    e.preventDefault();
    openSettingsPanel();
    return;
  }
}

function handleNativeEsc() {
  if (document.getElementById('pp-overlay')) return; // profile picker handles it
  if (!isTerminalTab(activeTab)) return;
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
      await acceptHostKey(hostname);
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
