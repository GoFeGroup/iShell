import '@xterm/xterm/css/xterm.css';
import { acceptHostKey, connect, connectLocal, disconnect, focusWindow, on, off, getSession, getSettings, getVersion, sendInput, launchNewInstance } from './api.js';
import { initSidebar, loadProfiles, setSessionStatus, LOCAL_SESSION } from './sidebar.js';
import { openProfileForm } from './profile-form.js';
import { initProfilePicker, openProfilePicker } from './profile-picker.js';
import { createTerminal, destroyTerminal, focusTerminal, fitTerminal, rememberTerminalViewport, setTerminalInputEnabled, setTerminalReconnectCallback, suspendTerminalAutoFit, writeTerminalLine } from './terminal.js';
import { initSFTP } from './sftp.js';
import { initSettings } from './settings.js';
import { initQuickCommands, setQuickCommandSettings, toggleQuickCommands, updateQuickCommandUI, triggerQuickCommandShortcut } from './quick-command.js';
import {
  initAISidebar, setAISidebarSettings, notifyActiveTerminalChanged,
  createAISidebarForTab, activateAISidebarForTab, deactivateAISidebar, destroyAISidebarForTab,
  suspendAISidebarLayout,
} from './ai-sidebar.js';
import { showToast } from './toast.js';
import { t, applyI18nAttrs, setLanguage, getLanguagePref } from './i18n.js';

// Apply the persisted/system-detected language to static markup as early as
// possible (module top-level runs once the DOM is parsed, before 'load').
applyI18nAttrs();

// ── State ─────────────────────────────────────────────────────────────────────
let tabs = [];          // terminal/sftp: { type, id, connID, sessionID, sessionLabel, host, username, terminalContent, aiSidebarOpen }; pending/failed terminal: { type, id, sess, error }; settings: { type, id, sessionLabel }
let activeTab = null;
let settings = null;
let isFullscreen = false;
const pendingConnects = {}; // sessionID → { sess, req, tab, attemptID } — kept until host key dialog resolves
const closingConnIDs = new Set();
let connectAttemptSeq = 0;
const PERF_DEBUG = true;

function perfLog(label, ...args) {
  if (PERF_DEBUG) console.log('[PERF-TAB]', label, ...args);
}

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

  getVersion().then(v => {
    const el = document.querySelector('.app-version');
    if (el) el.textContent = v;
  }).catch(() => {});

  initSidebar(onConnectRequest);
  initProfilePicker(onConnectRequest);
  initQuickCommands(settings, () => isTerminalTab(activeTab) ? activeTab.connID : null,
    () => activeTab?.quickCommandBar || null);
  initAISidebar(settings, () => isTerminalTab(activeTab) ? activeTab : null);

  // Toolbar buttons
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('btn-disconnect').addEventListener('click', () => hasTerminalConn(activeTab) && doDisconnect(activeTab.connID));
  document.getElementById('btn-sftp').addEventListener('click', toggleSFTP);
  document.getElementById('btn-quick-command').addEventListener('click', toggleQuickCommands);
  document.getElementById('btn-settings').addEventListener('click', () => openSettingsPanel());
  document.getElementById('btn-new-instance').addEventListener('click', openNewInstance);
  document.getElementById('btn-search-term').addEventListener('click', toggleFind);
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);

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
  ensureTerminalContent(tab);
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
    const closedTab = tabs.find(t => isTerminalTab(t) && t.connID === connID);
    console.log('[local-reconnect] terminal:closed fired', { connID, closedTabFound: !!closedTab, isLocal: closedTab?.isLocal });
    if (!closedTab) return;
    if (closedTab.isLocal) handleLocalConnectionClosed(closedTab, connID);
    else handleSSHConnectionClosed(closedTab, connID);
  });
  setSessionStatus(sess.id, 'connected');
  showToast(t('toast.connected', { host: sess.host }));
}

async function handleSSHConnectionClosed(tab, connID) {
  console.log('[reconnect] terminal:closed fired', { connID, tabType: tab?.type, tabInList: tabs.includes(tab) });
  if (!tabs.includes(tab) || tab.connID !== connID || tab.type !== 'terminal') {
    console.log('[reconnect] guard rejected - skipping disconnect handler');
    return;
  }

  off('terminal:closed:' + connID);
  setTerminalInputEnabled(connID, false);
  setTerminalReconnectCallback(connID, () => {
    const tab = tabs.find(t => t.connID === connID && t.type === 'terminal-disconnected');
    console.log('[reconnect] onData Enter callback fired', { connID, tabFound: !!tab, tabType: tab?.type });
    if (tab) reconnectRemoteTab(tab);
  });
  console.log('[reconnect] tab marked disconnected', { connID });
  const cleanup = disconnect(connID).catch(() => {});

  const removedActiveSFTP = activeTab?.type === 'sftp' && activeTab.connID === connID;
  tabs = tabs.filter(t => !(t.type === 'sftp' && t.connID === connID));
  tab.type = 'terminal-disconnected';
  tab.error = '';
  tab.pendingMessage = '';

  if (!tabs.some(t => t !== tab && isTerminalTab(t) && t.sessionID === tab.sessionID)) {
    setSessionStatus(tab.sessionID, 'disconnected');
  }
  if (tab.statusEl) tab.statusEl.textContent = t('terminal.disconnectedStatus');
  writeTerminalLine(connID, t('terminal.pressEnterToReconnect'));
  renderTabs();

  if (activeTab === tab) {
    updateConnUI(null);
    deactivateAISidebar();
    notifyActiveTerminalChanged();
    focusTerminal(connID);
  } else if (removedActiveSFTP) {
    await switchToTab(tab);
  } else if (activeTab) {
    updateConnUI(tabForConnActions(activeTab));
  }
  showToast(t('toast.disconnected'));
  await cleanup;
}

async function reconnectRemoteTab(tab) {
  console.log('[reconnect] reconnectRemoteTab called', { tabType: tab?.type, connID: tab?.connID, sessionID: tab?.sessionID });
  if (!tab || tab.type !== 'terminal-disconnected') {
    console.log('[reconnect] early return - tab not in disconnected state');
    return;
  }

  const oldConnID = tab.connID;
  tab.type = 'terminal-pending';
  tab.connID = '';
  tab.pendingMessage = t('terminal.loadingProfile');
  renderTabs();
  setTerminalReconnectCallback(oldConnID, null);
  destroyTerminal(oldConnID);
  if (activeTab === tab) renderTerminalState(tab);

  try {
    console.log('[reconnect] fetching session', tab.sessionID);
    const sess = await getSession(tab.sessionID);
    console.log('[reconnect] session fetched', { found: !!sess, host: sess?.host, authType: sess?.auth_type });
    if (!sess) throw new Error(t('terminal.profileNotFound'));
    tab.sess = { ...sess };
    tab.sessionLabel = sess.label || sess.host;
    tab.host = sess.host;
    tab.username = sess.username;
    if (!tabs.includes(tab) || tab.closed || tab.type !== 'terminal-pending') {
      console.log('[reconnect] tab gone or state changed after getSession - aborting');
      return;
    }
    console.log('[reconnect] calling connectRemoteTab');
    await connectRemoteTab(tab);
    console.log('[reconnect] connectRemoteTab resolved');
  } catch (e) {
    console.error('[reconnect] reconnect failed', e);
    if (tabs.includes(tab) && !tab.closed && tab.type === 'terminal-pending') failTerminalTab(tab, e);
  }
}

async function handleLocalConnectionClosed(tab, connID) {
  console.log('[local-reconnect] handleLocalConnectionClosed', { connID, tabType: tab?.type, tabInList: tabs.includes(tab) });
  if (!tabs.includes(tab) || tab.connID !== connID || tab.type !== 'terminal') {
    console.log('[local-reconnect] guard rejected');
    return;
  }

  off('terminal:closed:' + connID);
  setTerminalInputEnabled(connID, false);
  setTerminalReconnectCallback(connID, () => {
    const t = tabs.find(t => t.connID === connID && t.type === 'terminal-disconnected');
    console.log('[local-reconnect] onData Enter callback', { connID, tabFound: !!t });
    if (t) reconnectLocalTab(t);
  });
  console.log('[local-reconnect] tab marked disconnected', { connID });
  const cleanup = disconnect(connID).catch(() => {});

  tab.type = 'terminal-disconnected';
  tab.error = '';
  tab.pendingMessage = '';

  if (!tabs.some(t => t !== tab && isTerminalTab(t) && t.sessionID === tab.sessionID)) {
    setSessionStatus(tab.sessionID, 'disconnected');
  }
  if (tab.statusEl) tab.statusEl.textContent = t('terminal.disconnectedStatus');
  writeTerminalLine(connID, t('terminal.pressEnterToReconnect'));
  renderTabs();

  if (activeTab === tab) {
    updateConnUI(null);
    deactivateAISidebar();
    notifyActiveTerminalChanged();
    focusTerminal(connID);
  } else if (activeTab) {
    updateConnUI(tabForConnActions(activeTab));
  }
  showToast(t('toast.disconnected'));
  await cleanup;
}

async function reconnectLocalTab(tab) {
  console.log('[local-reconnect] reconnectLocalTab called', { tabType: tab?.type, isLocal: tab?.isLocal, connID: tab?.connID });
  if (!tab || !tab.isLocal ||
      (tab.type !== 'terminal-disconnected' && tab.type !== 'terminal-failed')) {
    console.log('[local-reconnect] early return from reconnectLocalTab');
    return;
  }

  const oldConnID = tab.connID;
  tab.type = 'terminal-pending';
  tab.connID = '';
  tab.pendingMessage = t('terminal.connectingTo', { host: tab.sessionLabel });
  renderTabs();
  setTerminalReconnectCallback(oldConnID, null);
  try { destroyTerminal(oldConnID); } catch (e) { console.warn('[local-reconnect] destroyTerminal error', e); }
  if (activeTab === tab) renderTerminalState(tab);

  try {
    const { cols, rows } = getTerminalSize();
    console.log('[local-reconnect] calling connectLocal', { cols, rows });
    const connID = await connectLocal(cols, rows);
    console.log('[local-reconnect] connectLocal returned', { connID });
    if (tabs.includes(tab) && !tab.closed && tab.type === 'terminal-pending') {
      const sess = { id: '__local__', label: tab.sessionLabel, host: tab.host || 'localhost', username: tab.username };
      console.log('[local-reconnect] calling afterConnect', { connID, sess });
      await afterConnect(connID, sess, tab);
      setSessionStatus('__local__', 'connected');
      console.log('[local-reconnect] reconnect complete');
    } else {
      console.log('[local-reconnect] tab gone/changed after connectLocal, aborting');
      disconnect(connID).catch(() => {});
    }
  } catch (e) {
    console.error('[local-reconnect] reconnect failed', e);
    if (tabs.includes(tab) && !tab.closed && tab.type === 'terminal-pending') {
      setSessionStatus('__local__', 'disconnected');
      failTerminalTab(tab, e);
    }
  }
}

function getTerminalSize() {
  const el = activeTab?.terminalContainer || document.getElementById('panel-terminal');
  return {
    cols: Math.floor((el?.clientWidth || 800) / 8),
    rows: Math.floor((el?.clientHeight || 400) / 17),
  };
}

function createPendingTerminalTab(sess) {
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
    aiSidebarOpen: false,
  };
  tabs.push(tab);
  renderTabs();
  return tab;
}

function ensureTerminalContent(tab) {
  if (!tab || tab.terminalContent) return;
  const panel = document.getElementById('panel-terminal');
  if (!panel) return;
  const suffix = tab.id.replace(/[^a-zA-Z0-9_-]/g, '-');
  tab.terminalContainerId = 'terminal-container-' + suffix;
  tab.sizeElId = 'sb-size-' + suffix;

  const content = document.createElement('div');
  content.className = 'terminal-tab-content';
  content.innerHTML = `
    <div class="terminal-main">
      <div class="terminal-container" id="${tab.terminalContainerId}"></div>
      <div class="find-bar" style="display:none;">
        <input placeholder="Find…" data-i18n-placeholder="terminal.findPlaceholder" />
        <span class="find-count"></span>
        <button class="btn btn-ghost btn-icon find-prev">▲</button>
        <button class="btn btn-ghost btn-icon find-next">▼</button>
        <button class="btn btn-ghost btn-icon find-close">✕</button>
      </div>
      <div class="quick-command-bar" style="display:none;"></div>
      <div class="terminal-statusbar">
        <div class="statusbar-left">
          <span class="statusbar-item terminal-status">🟢 ${t('common.connected')}</span>
          <span class="statusbar-item terminal-latency"></span>
        </div>
        <div class="statusbar-right">
          <span class="statusbar-item">UTF-8</span>
          <span class="statusbar-item terminal-size" id="${tab.sizeElId}">—</span>
        </div>
      </div>
    </div>

    <div class="ai-sidebar-resizer" style="display:none;"></div>
    <aside class="ai-sidebar collapsed">
      <div class="ai-sidebar-inner">
        <div class="ai-sidebar-header">
          <button class="btn btn-ghost btn-icon ai-back" title="${t('aiSidebar.back')}" style="display:none;">←</button>
          <div class="ai-sidebar-title">${t('aiSidebar.title')}</div>
          <button class="btn btn-ghost btn-icon ai-close" title="${t('common.close')}">✕</button>
        </div>
        <div class="ai-session-list" style="display:none;"></div>
        <div class="ai-chat-view" style="display:none;"></div>
      </div>
    </aside>`;

  tab.terminalContent = content;
  tab.terminalContainer = content.querySelector('.terminal-container');
  tab.findBar = content.querySelector('.find-bar');
  tab.findInput = tab.findBar?.querySelector('input');
  tab.quickCommandBar = content.querySelector('.quick-command-bar');
  tab.statusEl = content.querySelector('.terminal-status');
  tab.sizeEl = content.querySelector('.terminal-size');
  tab.findBar?.querySelector('.find-close')?.addEventListener('click', () => setFindBar(false));

  createAISidebarForTab(tab, {
    root: content.querySelector('.ai-sidebar'),
    inner: content.querySelector('.ai-sidebar-inner'),
    resizer: content.querySelector('.ai-sidebar-resizer'),
    listEl: content.querySelector('.ai-session-list'),
    chatEl: content.querySelector('.ai-chat-view'),
    backBtn: content.querySelector('.ai-back'),
    closeBtn: content.querySelector('.ai-close'),
  }, {
    getConnID: () => activeTab === tab ? tab.connID : '',
    onLayoutChange: refitActiveTerminalAfterLayout,
    onResizeStart: () => suspendTerminalAutoFit(true),
    onResizeEnd: () => suspendTerminalAutoFit(false),
  });

  panel.appendChild(content);
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
  ensureTerminalContent(tab);
  const container = tab.terminalContainer;
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

  const status = tab.statusEl;
  const size = tab.sizeEl;
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

function doDisconnect(connID) {
  if (!connID || closingConnIDs.has(connID)) return;
  closingConnIDs.add(connID);

  const removedTabs = tabs.filter(t => t.connID === connID);
  if (removedTabs.length === 0) {
    closingConnIDs.delete(connID);
    return;
  }

  const wasActive = !!activeTab && activeTab.connID === connID;
  const primaryClosedTab = wasActive ? activeTab : removedTabs[0];
  const closedIndex = Math.max(0, tabs.indexOf(primaryClosedTab));
  const sessionIDs = new Set(removedTabs.map(t => t.sessionID).filter(Boolean));

  tabs = tabs.filter(t => t.connID !== connID);
  off('terminal:closed:' + connID);

  // Only mark disconnected when no remaining connection tab for this profile.
  sessionIDs.forEach(sessionID => {
    if (!tabs.some(t => hasTerminalConn(t) && t.sessionID === sessionID)) {
      setSessionStatus(sessionID, 'disconnected');
    }
  });

  // Update tab bar UI before cleanup — guarantees renderTabs() runs even if cleanup throws.
  renderTabs();
  if (wasActive) activateFallbackTab(closedIndex);
  else if (activeTab) updateConnUI(tabForConnActions(activeTab));
  else showWelcome();
  showToast(t('toast.disconnected'));

  // Cleanup after UI update; exceptions here won't leave a ghost tab.
  removedTabs.forEach(destroyTerminalContent);
  destroyTerminal(connID);

  disconnect(connID)
    .catch(e => console.warn('disconnect:', e))
    .finally(() => closingConnIDs.delete(connID));
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
    const isDisconnected = tab.type === 'terminal-disconnected';
    const el = document.createElement('div');
    el.className = 'tab' + (tab === activeTab ? ' active' : '') + (isFailed ? ' failed' : '');
    el.dataset.tabId = tab.id;
    el.innerHTML = `
      ${isSettings ? '<span class="tab-icon">⚙</span>' : isSFTP ? '<span class="tab-icon">📁</span>' : `<div class="status-dot ${isFailed ? 'failed' : isPending ? 'connecting' : isDisconnected ? 'disconnected' : 'connected'}" style="width:6px;height:6px;"></div>`}
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

// Switching tabs only ever changes which tab is active — the rest of the
// strip (labels, status dots, indices) is untouched, so toggling the
// `.active` class on the two affected elements avoids tearing down and
// rebuilding every tab's DOM node (and re-binding its click listener) on
// every single switch. Falls back to a full renderTabs() the one time it's
// needed: a brand-new tab (settings/sftp/pending) that has no DOM node yet.
function updateActiveTabClass() {
  const scroll = document.getElementById('tabs-scroll');
  if (!scroll) return;
  const activeId = activeTab?.id;
  let found = !activeId;
  scroll.querySelectorAll('.tab').forEach(el => {
    const isActive = el.dataset.tabId === activeId;
    el.classList.toggle('active', isActive);
    if (isActive) found = true;
  });
  if (!found) renderTabs();
}

async function switchToTab(tab) {
  if (!tab) return;
  const switchStartedAt = performance.now();
  const previousTab = activeTab;
  perfLog('start', {
    targetTab: tab.id,
    targetType: tab.type,
    targetAIOpen: !!tab.aiSidebarOpen,
    previousTab: previousTab?.id || null,
  });
  if (hasTerminalConn(activeTab)) rememberTerminalViewport(activeTab.connID);
  if (tab.type === 'settings') {
    activeTab = tab;
    updateActiveTabClass();
    showPanel('settings');
    updateConnUI(null);
    deactivateAISidebar();
    notifyActiveTerminalChanged();
    await initSettings(tab.settingsPage);
    return;
  }
  if (tab.type === 'sftp') {
    activeTab = tab;
    updateActiveTabClass();
    showPanel('sftp');
    updateConnUI(tab);
    deactivateAISidebar();
    notifyActiveTerminalChanged();
    await initSFTP(tab.connID);
    return;
  }
  if (tab.type === 'terminal-disconnected') {
    activeTab = tab;
    ensureTerminalContent(tab);
    updateActiveTabClass();
    showPanel('terminal');
    showTerminalContent(tab, previousTab);
    updateConnUI(null);
    if (tab.statusEl) tab.statusEl.textContent = t('terminal.disconnectedStatus');
    focusTerminal(tab.connID);
    deactivateAISidebar();
    notifyActiveTerminalChanged();
    return;
  }
  if (tab.type === 'terminal-pending' || tab.type === 'terminal-failed') {
    activeTab = tab;
    ensureTerminalContent(tab);
    updateActiveTabClass();
    showPanel('terminal');
    showTerminalContent(tab, previousTab);
    updateConnUI(null);
    renderTerminalState(tab);
    deactivateAISidebar();
    notifyActiveTerminalChanged();
    return;
  }
  activeTab = tab;
  ensureTerminalContent(tab);
  updateActiveTabClass();
  showPanel('terminal');
  showTerminalContent(tab, previousTab);
  perfLog('after showTerminalContent', (performance.now() - switchStartedAt).toFixed(1) + 'ms');
  updateConnUI(tab);
  // A pending/failed connection renders a state card into the terminal
  // container. Remove that transient UI before mounting the live xterm after
  // a successful retry or reconnect.
  tab.terminalContainer?.querySelector('.terminal-state')?.remove();
  createTerminal(tab.connID, settings, { containerId: tab.terminalContainerId, sizeElId: tab.sizeElId });
  perfLog('after createTerminal', (performance.now() - switchStartedAt).toFixed(1) + 'ms');
  const status = tab.statusEl;
  if (status) status.textContent = t('common.connected');
  focusTerminal(tab.connID);
  perfLog('after focusTerminal', (performance.now() - switchStartedAt).toFixed(1) + 'ms');
  activateAISidebarForTab(tab);
  perfLog('after activateAISidebarForTab', (performance.now() - switchStartedAt).toFixed(1) + 'ms');
  notifyActiveTerminalChanged();
  perfLog('done', (performance.now() - switchStartedAt).toFixed(1) + 'ms');
  requestAnimationFrame(() => {
    perfLog('first RAF', (performance.now() - switchStartedAt).toFixed(1) + 'ms');
    requestAnimationFrame(() => {
      perfLog('second RAF', (performance.now() - switchStartedAt).toFixed(1) + 'ms');
    });
  });
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
  if (tab.type === 'terminal-disconnected') {
    closeDisconnectedTerminalTab(tab);
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
  destroyTerminalContent(tab);
  renderTabs();
  if (wasActive) activateFallbackTab(closedIndex);
}

function closeDisconnectedTerminalTab(tab) {
  const closedIndex = tabs.indexOf(tab);
  const wasActive = tab === activeTab;
  tabs = tabs.filter(t => t !== tab);
  destroyTerminal(tab.connID);
  destroyTerminalContent(tab);
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
  deactivateAISidebar();
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

function showTerminalContent(tab, previousTab = null) {
  if (previousTab?.terminalContent && previousTab.terminalContent !== tab.terminalContent) {
    suspendAISidebarLayout(previousTab);
    previousTab.terminalContent.classList.remove('active');
    previousTab.terminalContent.setAttribute('aria-hidden', 'true');
  }
  if (tab?.terminalContent) {
    tab.terminalContent.classList.add('active');
    tab.terminalContent.removeAttribute('aria-hidden');
    return;
  }
  document.querySelectorAll('#panel-terminal .terminal-tab-content').forEach(el => {
    const isActive = el === tab?.terminalContent;
    if (!isActive) {
      const t = tabs.find(t => t.terminalContent === el);
      suspendAISidebarLayout(t);
    }
    el.classList.toggle('active', isActive);
    if (isActive) el.removeAttribute('aria-hidden');
    else el.setAttribute('aria-hidden', 'true');
  });
}

function destroyTerminalContent(tab) {
  if (!tab) return;
  destroyAISidebarForTab(tab);
  tab.terminalContent?.remove();
  tab.terminalContent = null;
  tab.terminalContainer = null;
  tab.findBar = null;
  tab.findInput = null;
  tab.quickCommandBar = null;
  tab.statusEl = null;
  tab.sizeEl = null;
}

function refitActiveTerminal(options = {}) {
  if (!isTerminalTab(activeTab)) return;
  requestAnimationFrame(() => {
    if (!isTerminalTab(activeTab)) return;
    if (document.getElementById('panel-terminal')?.style.display === 'none') return;
    fitTerminal(activeTab.connID, { ...options, caller: 'refitActiveTerminal-RAF' });
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
  if (!activeTab?.findBar) return;
  setFindBar(activeTab.findBar.style.display === 'none');
}
function setFindBar(show) {
  if (!activeTab?.findBar) return;
  activeTab.findBar.style.display = show ? '' : 'none';
  if (show) activeTab.findInput?.focus();
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
  if (e.key === 'Enter') {
    console.log('[reconnect] Enter keydown', { activeTabType: activeTab?.type, isLocal: activeTab?.isLocal, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
  }
  const noMod = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
  if (e.key === 'Enter' && noMod &&
      (activeTab?.type === 'terminal-disconnected' || activeTab?.type === 'terminal-failed')) {
    console.log('[reconnect] triggering reconnect from handleKeydown', { type: activeTab.type });
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    if (activeTab.type === 'terminal-disconnected') {
      if (activeTab.isLocal) reconnectLocalTab(activeTab);
      else reconnectRemoteTab(activeTab);
    } else if (activeTab.isLocal) {
      reconnectLocalTab(activeTab);
    } else if (activeTab.sess) {
      connectRemoteTab(activeTab);
    }
    return;
  }
  const key = e.key.toLowerCase();
  const appMod = isMac
    ? (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey)
    : (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey);
  if (appMod && key === 'w') {
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
  if (appMod && key === 't') {
    e.preventDefault();
    onLocalConnectRequest(LOCAL_SESSION);
    return;
  }
  if (appMod && key === 'o') {
    e.preventDefault();
    openProfilePicker();
    return;
  }
  if (e.key === 'Enter' && (isMac ? e.metaKey : e.altKey)) {
    e.preventDefault();
    toggleFullscreen();
    return;
  }
  if (appMod && key === 'b') {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  if (appMod && key === 'f') {
    const panelTerm = document.getElementById('panel-terminal');
    if (panelTerm && panelTerm.style.display !== 'none') {
      e.preventDefault();
      toggleFind();
    }
    return;
  }
  if (appMod && e.key === ',') {
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
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
