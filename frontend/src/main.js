import '@xterm/xterm/css/xterm.css';
import { acceptHostKey, connect, connectLocal, disconnect, focusWindow, on, off, getSettings, sendInput, launchNewInstance } from './api.js';
import { initSidebar, loadProfiles, setSessionStatus, LOCAL_SESSION } from './sidebar.js';
import { openProfileForm } from './profile-form.js';
import { initProfilePicker, openProfilePicker } from './profile-picker.js';
import { createTerminal, destroyTerminal, focusTerminal, fitTerminal, rememberTerminalViewport } from './terminal.js';
import { initSFTP } from './sftp.js';
import { initSettings } from './settings.js';
import { initQuickCommands, setQuickCommandSettings, toggleQuickCommands, updateQuickCommandUI, triggerQuickCommandShortcut } from './quick-command.js';
import { initAISidebar, setAISidebarSettings, toggleAISidebar, notifyActiveTerminalChanged, closeAISidebar } from './ai-sidebar.js';
import { showToast } from './toast.js';
import { t, applyI18nAttrs, setLanguage, getLanguagePref } from './i18n.js';

// Apply the persisted/system-detected language to static markup as early as
// possible (module top-level runs once the DOM is parsed, before 'load').
applyI18nAttrs();

// ── State ─────────────────────────────────────────────────────────────────────
let tabs = [];          // terminal/sftp: { type, id, connID, sessionID, sessionLabel, host, username }; pending/failed terminal: { type, id, sess, error }; settings: { type, id, sessionLabel }
let activeTab = null;
let settings = null;
let isFullscreen = false;
const pendingConnects = {}; // sessionID → { sess, req, tab, attemptID } — kept until host key dialog resolves
let connectAttemptSeq = 0;

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  // Bring window to front on startup; works around Windows foreground-steal restriction.
  focusWindow().catch(() => {});

  settings = await getSettings().catch(() => ({}));
  if (settings?.theme) {
    document.documentElement.setAttribute('data-theme', settings.theme);
    localStorage.setItem('theme', settings.theme);
  }
  if (settings?.language && settings.language !== getLanguagePref()) {
    setLanguage(settings.language);
  }

  initSidebar(onConnectRequest);
  initProfilePicker(onConnectRequest);
  initQuickCommands(settings, () => isTerminalTab(activeTab) ? activeTab.connID : null);
  initAISidebar(settings, () => isTerminalTab(activeTab) ? { targetID: activeTab.sessionID, connID: activeTab.connID } : null);

  // Toolbar buttons
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('btn-disconnect').addEventListener('click', () => hasTerminalConn(activeTab) && doDisconnect(activeTab.connID));
  document.getElementById('btn-sftp').addEventListener('click', toggleSFTP);
  document.getElementById('btn-quick-command').addEventListener('click', toggleQuickCommands);
  document.getElementById('btn-settings').addEventListener('click', () => openSettingsPanel());
  document.getElementById('btn-new-instance').addEventListener('click', openNewInstance);
  document.getElementById('btn-toggle-ai').addEventListener('click', toggleAISidebar);
  document.getElementById('btn-search-term').addEventListener('click', toggleFind);
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.getElementById('find-close').addEventListener('click', () => setFindBar(false));

  // Update shortcut hints based on platform
  const fsKey = isMac ? '⌘↩' : 'Alt+Enter';
  document.querySelectorAll('.kbd-hint kbd').forEach(el => {
    if (el.textContent === 'Alt+Enter') el.textContent = fsKey;
  });
  document.getElementById('btn-fullscreen').title = t('app.fullscreenTitle', { key: fsKey });
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
  window.addEventListener('ishell:openSettings', (e) => openSettingsPanel(e.detail?.page));
  window.addEventListener('ishell:settingsSaved', (e) => {
    settings = e.detail?.settings || settings;
    setQuickCommandSettings(settings);
    setAISidebarSettings(settings);
    refitActiveTerminal();
  });
  window.addEventListener('ishell:nativeEsc', handleNativeEsc);
  window.addEventListener('ishell:aiSidebarToggled', refitActiveTerminalAfterLayout);
  window.addEventListener('ishell:languageChanged', () => {
    loadProfiles();
    renderTabs();
  });

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
  const tab = createPendingTerminalTab(sess);
  await switchToTab(tab);
  await connectRemoteTab(tab);
}

async function connectRemoteTab(tab, overrides = {}) {
  const sess = tab.sess;
  showToast(t('toast.connecting', { host: sess.host }));
  setSessionStatus(sess.id, 'connecting');

  const req = {
    session_id: sess.id,
    password: sess.auth_type === 'password' ? sess.password : '',
    key_path: sess.auth_type === 'key' ? sess.key_path : '',
    passphrase: sess.auth_type === 'key' ? sess.passphrase : '',
    ...getTerminalSize(),
    ...overrides,
  };
  const attemptID = ++connectAttemptSeq;
  tab.attemptID = attemptID;
  tab.type = 'terminal-pending';
  tab.error = '';
  tab.pendingMessage = '';
  renderTabs();
  if (activeTab === tab) renderTerminalState(tab);

  // Store for potential host-key retry
  pendingConnects[sess.id] = { sess, req, tab, attemptID };

  try {
    const connID = await connect(req);
    if (tab.closed || tab.attemptID !== attemptID) {
      disconnect(connID).catch(() => {});
      return;
    }
    delete pendingConnects[sess.id];
    await afterConnect(connID, sess, tab);
  } catch (e) {
    if (tab.closed || tab.attemptID !== attemptID) return;
    if (isHostKeyPromptError(e)) {
      tab.pendingMessage = t('terminal.waitingHostKey');
      renderTabs();
      if (activeTab === tab) renderTerminalState(tab);
      return; // dialog will handle retry/reject
    }
    failTerminalTab(tab, e);
  }
}

async function onLocalConnectRequest(localSess) {
  closeAISidebar();
  showToast(t('toast.openingLocal', { sub: localSess.sublabel }));
  setSessionStatus('__local__', 'connecting');

  const { cols, rows } = getTerminalSize();

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

async function afterConnect(connID, sess, existingTab = null) {
  const tab = existingTab || { id: 'tab-' + Date.now() };
  Object.assign(tab, {
    type: 'terminal',
    connID,
    sessionID: sess.id,
    sessionLabel: sess.label || sess.host,
    host: sess.host,
    username: sess.username,
    isLocal: sess.id === '__local__',
    sess: undefined,
    error: undefined,
    pendingMessage: undefined,
  });
  if (!tabs.includes(tab)) tabs.push(tab);
  renderTabs();
  switchToTab(tab);
  on('terminal:closed:' + connID, () => {
    if (tabs.some(t => isTerminalTab(t) && t.connID === connID)) doDisconnect(connID);
  });
  setSessionStatus(sess.id, 'connected');
  showToast(t('toast.connected', { host: sess.host }));
}

function getTerminalSize() {
  const el = document.getElementById('terminal-container');
  return {
    cols: Math.floor((el?.clientWidth || 800) / 8),
    rows: Math.floor((el?.clientHeight || 400) / 17),
  };
}

function createPendingTerminalTab(sess) {
  closeAISidebar();
  const tab = {
    type: 'terminal-pending',
    id: 'tab-pending-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    sessionID: sess.id,
    sessionLabel: sess.label || sess.host,
    host: sess.host,
    username: sess.username,
    sess: { ...sess },
    error: '',
    pendingMessage: '',
  };
  tabs.push(tab);
  renderTabs();
  return tab;
}

function failTerminalTab(tab, err) {
  if (!tab || tab.closed) return;
  if (tab.sessionID && pendingConnects[tab.sessionID]?.tab === tab) {
    delete pendingConnects[tab.sessionID];
  }
  tab.type = 'terminal-failed';
  tab.error = String(err?.message || err || t('terminal.unknownError'));
  tab.pendingMessage = '';
  setSessionStatus(tab.sessionID, 'disconnected');
  renderTabs();
  if (activeTab === tab) renderTerminalState(tab);
  showToast(`❌ ${tab.error}`);
}

function renderTerminalState(tab) {
  const container = document.getElementById('terminal-container');
  if (!container) return;
  container.innerHTML = '';
  const isFailed = tab.type === 'terminal-failed';
  const detail = formatSessionEndpoint(tab.sess || tab);
  const message = isFailed
    ? tab.error
    : (tab.pendingMessage || t('terminal.connectingTo', { host: tab.host || tab.sessionLabel }));

  const state = document.createElement('div');
  state.className = 'terminal-state' + (isFailed ? ' failed' : '');
  state.innerHTML = `
    <div class="terminal-state-card">
      <div class="terminal-state-icon">${isFailed ? '!' : ''}</div>
      <div class="terminal-state-title">${escHtml(isFailed ? t('terminal.connectionFailedTitle') : t('terminal.connectingTitle'))}</div>
      <div class="terminal-state-sub">${escHtml(tab.sessionLabel || '')}</div>
      <div class="terminal-state-endpoint">${escHtml(detail)}</div>
      <pre class="terminal-state-message">${escHtml(message)}</pre>
      ${isFailed ? `
        <div class="terminal-state-actions">
          <button class="btn btn-primary btn-sm" data-action="retry">${t('terminal.retry')}</button>
          <button class="btn btn-secondary btn-sm" data-action="edit">${t('terminal.editProfile')}</button>
          <button class="btn btn-ghost btn-sm" data-action="close">${t('common.close')}</button>
        </div>` : ''}
    </div>`;
  container.appendChild(state);

  const status = document.getElementById('sb-status');
  const size = document.getElementById('sb-size');
  if (status) status.textContent = isFailed ? t('common.failed') : t('terminal.connectingStatus');
  if (size) size.textContent = '-';

  if (isFailed) {
    state.querySelector('[data-action="retry"]')?.addEventListener('click', () => connectRemoteTab(tab));
    state.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
      openProfileForm(tab.sess, (saved) => {
        loadProfiles();
        tab.sess = { ...saved };
        tab.sessionID = saved.id;
        tab.sessionLabel = saved.label || saved.host;
        tab.host = saved.host;
        tab.username = saved.username;
        renderTabs();
        if (activeTab === tab) renderTerminalState(tab);
      });
    });
    state.querySelector('[data-action="close"]')?.addEventListener('click', () => closeTab(tab));
  }
}

function formatSessionEndpoint(sess) {
  const user = sess.username ? `${sess.username}@` : '';
  const host = sess.host || sess.sessionLabel || '';
  const port = sess.port || 22;
  return `${user}${host}${host ? ':' + port : ''}`;
}

async function doDisconnect(connID) {
  try { await disconnect(connID); } catch {}
  const tab = tabs.find(t => t.connID === connID);
  const closedIndex = tabs.indexOf(tab);
  const wasActive = !!activeTab && activeTab.connID === connID;
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
  else if (activeTab) updateConnUI(tabForConnActions(activeTab));
  else showWelcome();
  showToast(t('toast.disconnected'));
}

// ── Tab management ────────────────────────────────────────────────────────────

function renderTabs() {
  const scroll = document.getElementById('tabs-scroll');
  scroll.innerHTML = '';
  tabs.forEach((tab, idx) => {
    const isSettings = tab.type === 'settings';
    const isSFTP = tab.type === 'sftp';
    const isFailed = tab.type === 'terminal-failed';
    const isPending = tab.type === 'terminal-pending';
    const el = document.createElement('div');
    el.className = 'tab' + (tab === activeTab ? ' active' : '') + (isFailed ? ' failed' : '');
    el.dataset.tabId = tab.id;
    el.innerHTML = `
      ${isSettings ? '<span class="tab-icon">⚙</span>' : isSFTP ? '<span class="tab-icon">📁</span>' : `<div class="status-dot ${isFailed ? 'failed' : isPending ? 'connecting' : 'connected'}" style="width:6px;height:6px;"></div>`}
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
  addBtn.title = t('app.newConnectionTitle');
  addBtn.textContent = '+';
  addBtn.addEventListener('click', showWelcome);
  scroll.appendChild(addBtn);
}

async function switchToTab(tab) {
  if (!tab) return;
  if (hasTerminalConn(activeTab)) rememberTerminalViewport(activeTab.connID);
  if (tab.type === 'settings') {
    activeTab = tab;
    renderTabs();
    showPanel('settings');
    updateConnUI(null);
    updateQuickCommandUI();
    notifyActiveTerminalChanged();
    await initSettings(tab.settingsPage);
    return;
  }
  if (tab.type === 'sftp') {
    activeTab = tab;
    renderTabs();
    showPanel('sftp');
    updateConnUI(tab);
    updateQuickCommandUI();
    notifyActiveTerminalChanged();
    await initSFTP(tab.connID);
    return;
  }
  if (tab.type === 'terminal-pending' || tab.type === 'terminal-failed') {
    activeTab = tab;
    renderTabs();
    showPanel('terminal');
    updateConnUI(null);
    updateQuickCommandUI();
    renderTerminalState(tab);
    notifyActiveTerminalChanged();
    return;
  }
  activeTab = tab;
  renderTabs();
  showPanel('terminal');
  updateConnUI(tab);
  updateQuickCommandUI();
  createTerminal(tab.connID, settings);
  const status = document.getElementById('sb-status');
  if (status) status.textContent = t('common.connected');
  refitActiveTerminal({ restoreScroll: true });
  focusTerminal(tab.connID);
  notifyActiveTerminalChanged();
}

function switchToTabByIndex(n) {
  if (n < 1 || n > tabs.length) { showToast(t('toast.noTab', { n })); return; }
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
  if (tab.type === 'sftp') {
    closeSFTPTab(tab);
    return;
  }
  if (tab.type === 'terminal-pending' || tab.type === 'terminal-failed') {
    closeTransientTerminalTab(tab);
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

function closeSFTPTab(tab) {
  const closedIndex = tabs.indexOf(tab);
  const wasActive = tab === activeTab;
  tabs = tabs.filter(t => t !== tab);
  renderTabs();
  if (wasActive) activateFallbackTab(closedIndex);
}

function closeTransientTerminalTab(tab) {
  const closedIndex = tabs.indexOf(tab);
  const wasActive = tab === activeTab;
  tab.closed = true;
  tab.attemptID = -1;
  if (tab.sessionID && pendingConnects[tab.sessionID]?.tab === tab) {
    delete pendingConnects[tab.sessionID];
    setSessionStatus(tab.sessionID, 'disconnected');
  }
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
  renderTabs();
  showPanel('welcome');
  updateConnUI(null);
  updateQuickCommandUI();
  notifyActiveTerminalChanged();
}

function isTerminalTab(tab) {
  return !!tab && tab.type === 'terminal' && !!tab.connID;
}

function hasTerminalConn(tab) {
  return !!tab && (tab.type === 'terminal' || tab.type === 'sftp') && !!tab.connID;
}

function tabForConnActions(tab) {
  return hasTerminalConn(tab) ? tab : null;
}

// ── Panel management ──────────────────────────────────────────────────────────

function showPanel(name) {
  ['welcome', 'terminal', 'sftp', 'settings'].forEach(p => {
    const el = document.getElementById('panel-' + p);
    if (el) el.style.display = p === name ? '' : 'none';
  });
}

function refitActiveTerminal(options = {}) {
  if (!isTerminalTab(activeTab)) return;
  requestAnimationFrame(() => {
    if (!isTerminalTab(activeTab)) return;
    if (document.getElementById('panel-terminal')?.style.display === 'none') return;
    fitTerminal(activeTab.connID, options);
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
  const disconnectBtn = document.getElementById('btn-disconnect');
  const disconnectVdiv = document.getElementById('disconnect-vdiv');
  actions.style.display = hasConn ? '' : 'none';
  if (sftpBtn) sftpBtn.style.display = hasConn && !tab?.isLocal ? '' : 'none';
  if (disconnectBtn) disconnectBtn.style.display = hasConn ? '' : 'none';
  if (disconnectVdiv) disconnectVdiv.style.display = hasConn ? '' : 'none';
  updateQuickCommandUI();
}

// ── SFTP toggle ───────────────────────────────────────────────────────────────

async function toggleSFTP() {
  if (!hasTerminalConn(activeTab)) { showToast(t('toast.connectFirst')); return; }
  if (activeTab.isLocal) { showToast(t('toast.sftpRemoteOnly')); return; }
  const connID = activeTab.connID;
  let tab = tabs.find(t => t.type === 'sftp' && t.connID === connID);
  if (!tab) {
    tab = {
      type: 'sftp',
      id: 'tab-sftp-' + connID,
      connID,
      sessionID: activeTab.sessionID,
      sessionLabel: `SFTP: ${activeTab.sessionLabel}`,
      host: activeTab.host,
      username: activeTab.username,
      isLocal: activeTab.isLocal,
    };
    tabs.push(tab);
  }
  await switchToTab(tab);
}

// ── Settings panel ────────────────────────────────────────────────────────────

async function openSettingsPanel(page) {
  let tab = tabs.find(t => t.type === 'settings');
  if (!tab) {
    tab = {
      type: 'settings',
      id: 'tab-settings',
      sessionLabel: t('common.settings'),
    };
    tabs.push(tab);
  }
  tab.settingsPage = page || tab.settingsPage || 'appearance';
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
    showToast(t('toast.exitedFullscreen'));
  } else {
    window.runtime.WindowFullscreen();
    isFullscreen = true;
    if (btn) btn.textContent = '⊡';
    showToast(t('toast.fullscreenHint', { key: isMac ? 'Cmd+Enter' : 'Alt+Enter' }));
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
    ? (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '9')
    : (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key >= '1' && e.key <= '9');
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
  if (triggerQuickCommandShortcut(e)) return;
}

function handleNativeEsc() {
  if (document.getElementById('pp-overlay')) return; // profile picker handles it
  if (!hasTerminalConn(activeTab)) return;
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
    if (pending) failTerminalTab(pending.tab, t('terminal.hostKeyRejected'));
    showToast(t('toast.connectionRejected'));
  };

  document.getElementById('hostkey-once').onclick = async () => {
    close();
    const pending = findPendingConnect(session_id, hostname);
    if (!pending) { showToast(t('toast.noPendingConnection')); return; }
    delete pendingConnects[pending.sess.id];
    await connectRemoteTab(pending.tab, { skip_host_key_check: true });
  };

  document.getElementById('hostkey-always').onclick = async () => {
    close();
    const pending = findPendingConnect(session_id, hostname);
    if (!pending) { showToast(t('toast.noPendingConnection')); return; }
    delete pendingConnects[pending.sess.id];
    try {
      await acceptHostKey(hostname);
    } catch (e) {
      showToast(t('toast.hostKeySaveFailed', { e }));
    }
    await connectRemoteTab(pending.tab, { skip_host_key_check: true });
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
