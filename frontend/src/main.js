import '@xterm/xterm/css/xterm.css';
import { acceptHostKey, connect, connectLocal, disconnect, focusWindow, on, off, getSession, getSettings, getVersion, sendInput, launchNewInstance } from './api.js';
import { initSidebar, loadProfiles, setSessionStatus, LOCAL_SESSION } from './sidebar.js';
import { openProfileForm } from './profile-form.js';
import { initProfilePicker, openProfilePicker } from './profile-picker.js';
import { createTerminal, destroyTerminal, focusTerminal, fitTerminal, getTerminalCWD, getTerminalRecentOutput, getTerminalSelection, rememberTerminalViewport, setTerminalInputEnabled, setTerminalReconnectCallback, suspendTerminalAutoFit, writeTerminalLine } from './terminal.js';
import { initSFTP } from './sftp.js';
import { initSettings } from './settings.js';
import { initQuickCommands, setQuickCommandSettings, toggleQuickCommands, updateQuickCommandUI, triggerQuickCommandShortcut } from './quick-command.js';
import {
  initAISidebar, setAISidebarSettings, notifyActiveTerminalChanged,
  createAISidebarForTab, activateAISidebarForTab, deactivateAISidebar, destroyAISidebarForTab,
  suspendAISidebarLayout, toggleAISidebar,
} from './ai-sidebar.js';
import { showToast } from './toast.js';
import { t, applyI18nAttrs, setLanguage, getLanguagePref } from './i18n.js';

// Apply the persisted/system-detected language to static markup as early as
// possible (module top-level runs once the DOM is parsed, before 'load').
applyI18nAttrs();

// ── State ─────────────────────────────────────────────────────────────────────
let tabs = [];          // terminal: { type, id, panes[], activePaneId, splitDirection }; sftp/settings keep their existing flat shape
let activeTab = null;
let settings = null;
let isFullscreen = false;
const pendingConnects = {}; // attemptID → { sess, req, tab, pane, attemptID } — kept until host key dialog resolves
let connectAttemptSeq = 0;
const PERF_DEBUG = true;

function perfLog(label, ...args) {
  if (PERF_DEBUG) console.log('[PERF-TAB]', label, ...args);
}

function createTerminalPane(sess, state = 'pending') {
  return {
    id: 'pane-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    state,
    connID: '',
    sessionID: sess.id,
    sessionLabel: sess.label || sess.host,
    host: sess.host,
    username: sess.username,
    isLocal: sess.id === '__local__',
    sess: { ...sess },
    error: '',
    pendingMessage: '',
    attemptID: 0,
    closed: false,
  };
}

function terminalPanes(tab) {
  return isTerminalTab(tab) ? (tab.panes || []) : [];
}

function activeTerminalPane(tab = activeTab) {
  if (!isTerminalTab(tab)) return null;
  return terminalPanes(tab).find(p => p.id === tab.activePaneId) || terminalPanes(tab)[0] || null;
}

function activeConnectedPane(tab = activeTab) {
  const pane = activeTerminalPane(tab);
  return pane?.state === 'connected' && pane.connID ? pane : null;
}

function findTerminalPaneByConn(connID) {
  for (const tab of tabs) {
    if (!isTerminalTab(tab)) continue;
    const pane = terminalPanes(tab).find(p => p.connID === connID);
    if (pane) return { tab, pane };
  }
  return null;
}

function syncSessionStatus(sessionID) {
  if (!sessionID) return;
  const panes = tabs.flatMap(tab => isTerminalTab(tab) ? terminalPanes(tab) : [])
    .filter(p => p.sessionID === sessionID && !p.closed);
  if (panes.some(p => p.state === 'connected')) setSessionStatus(sessionID, 'connected');
  else if (panes.some(p => p.state === 'pending')) setSessionStatus(sessionID, 'connecting');
  else setSessionStatus(sessionID, 'disconnected');
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
  initQuickCommands(settings, () => activeConnectedPane()?.connID || null,
    () => activeTab?.quickCommandBar || null);
  initAISidebar(settings, () => isAITerminalTab(activeTab) ? activeTab : null);

  // Toolbar buttons
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('btn-disconnect').addEventListener('click', () => {
    const target = tabForConnActions(activeTab);
    if (target?.connID) doDisconnect(target.connID);
  });
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
  await connectRemotePane(tab, activeTerminalPane(tab));
}

async function connectRemotePane(tab, pane, overrides = {}) {
  if (!tab || !pane || pane.closed) return;
  const sess = pane.sess;
  ensureTerminalContent(tab);
  showToast(t('toast.connecting', { host: sess.host }));
  pane.state = 'pending';
  pane.error = '';
  pane.pendingMessage = '';
  syncSessionStatus(sess.id);

  const req = {
    session_id: sess.id,
    password: sess.auth_type === 'password' ? sess.password : '',
    key_path: sess.auth_type === 'key' ? sess.key_path : '',
    passphrase: sess.auth_type === 'key' ? sess.passphrase : '',
    ...getTerminalSize(pane),
    ...overrides,
  };
  const attemptID = ++connectAttemptSeq;
  pane.attemptID = attemptID;
  renderTabs();
  if (activeTab === tab) renderTerminalState(tab, pane);

  // Store for potential host-key retry
  pendingConnects[attemptID] = { sess, req, tab, pane, attemptID };

  try {
    const connID = await connect(req);
    if (pane.closed || pane.attemptID !== attemptID || !tabs.includes(tab)) {
      disconnect(connID).catch(() => {});
      return;
    }
    delete pendingConnects[attemptID];
    await afterConnect(connID, sess, tab, pane);
  } catch (e) {
    if (pane.closed || pane.attemptID !== attemptID || !tabs.includes(tab)) return;
    if (isHostKeyPromptError(e)) {
      pane.pendingMessage = t('terminal.waitingHostKey');
      renderTabs();
      if (activeTab === tab) renderTerminalState(tab, pane);
      return; // dialog will handle retry/reject
    }
    failTerminalPane(tab, pane, e);
  }
}

async function onLocalConnectRequest(localSess) {
  showToast(t('toast.openingLocal', { sub: localSess.sublabel }));
  const sess = {
    id: '__local__',
    label: localSess.label,
    host: 'localhost',
    username: localSess.sublabel,
  };
  const tab = createPendingTerminalTab(sess);
  await switchToTab(tab);
  await connectLocalPane(tab, activeTerminalPane(tab));
}

async function connectLocalPane(tab, pane) {
  if (!tab || !pane || pane.closed) return;
  pane.state = 'pending';
  pane.error = '';
  pane.pendingMessage = t('terminal.connectingTo', { host: pane.sessionLabel });
  const attemptID = ++connectAttemptSeq;
  pane.attemptID = attemptID;
  syncSessionStatus(pane.sessionID);
  renderTabs();
  if (activeTab === tab) renderTerminalState(tab, pane);
  const { cols, rows } = getTerminalSize(pane);
  try {
    const connID = await connectLocal(cols, rows);
    if (pane.closed || pane.attemptID !== attemptID || !tabs.includes(tab)) {
      disconnect(connID).catch(() => {});
      return;
    }
    await afterConnect(connID, pane.sess, tab, pane);
  } catch (e) {
    if (!pane.closed && pane.attemptID === attemptID && tabs.includes(tab)) {
      failTerminalPane(tab, pane, e);
    }
  }
}

async function afterConnect(connID, sess, tab, pane) {
  Object.assign(pane, {
    state: 'connected',
    connID,
    sessionID: sess.id,
    sessionLabel: sess.label || sess.host,
    host: sess.host,
    username: sess.username,
    isLocal: sess.id === '__local__',
    sess: { ...sess },
    error: undefined,
    pendingMessage: undefined,
  });
  tab.sessionID = sess.id;
  tab.sessionLabel = sess.label || sess.host;
  tab.host = sess.host;
  tab.username = sess.username;
  renderTabs();
  if (activeTab === tab) {
    ensurePaneElement(tab, pane);
    mountTerminalPane(tab, pane);
    setActivePane(tab, pane, { focus: true });
  } else {
    switchToTab(tab);
  }
  on('terminal:closed:' + connID, () => {
    const found = findTerminalPaneByConn(connID);
    console.log('[local-reconnect] terminal:closed fired', { connID, paneFound: !!found, isLocal: found?.pane?.isLocal });
    if (!found) return;
    if (found.pane.isLocal) handleLocalConnectionClosed(found.tab, found.pane, connID);
    else handleSSHConnectionClosed(found.tab, found.pane, connID);
  });
  syncSessionStatus(sess.id);
  showToast(t('toast.connected', { host: sess.host }));
}

async function handleSSHConnectionClosed(tab, pane, connID) {
  console.log('[reconnect] terminal:closed fired', { connID, paneState: pane?.state, tabInList: tabs.includes(tab) });
  if (!tabs.includes(tab) || pane?.connID !== connID || pane.state !== 'connected') {
    console.log('[reconnect] guard rejected - skipping disconnect handler');
    return;
  }

  off('terminal:closed:' + connID);
  setTerminalInputEnabled(connID, false);
  setTerminalReconnectCallback(connID, () => {
    const found = findTerminalPaneByConn(connID);
    if (found?.pane.state === 'disconnected') reconnectRemotePane(found.tab, found.pane);
  });
  console.log('[reconnect] pane marked disconnected', { connID });
  const cleanup = disconnect(connID).catch(() => {});

  const removedActiveSFTP = activeTab?.type === 'sftp' && activeTab.connID === connID;
  tabs = tabs.filter(t => !(t.type === 'sftp' && t.connID === connID));
  pane.state = 'disconnected';
  pane.error = '';
  pane.pendingMessage = '';
  syncSessionStatus(pane.sessionID);
  writeTerminalLine(connID, t('terminal.pressEnterToReconnect'));
  renderTabs();

  if (activeTab === tab && activeTerminalPane(tab) === pane) {
    updateActivePaneUI(tab);
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

async function reconnectRemotePane(tab, pane) {
  console.log('[reconnect] reconnectRemotePane called', { paneState: pane?.state, connID: pane?.connID, sessionID: pane?.sessionID });
  if (!tab || !pane || pane.state !== 'disconnected') {
    console.log('[reconnect] early return - pane not in disconnected state');
    return;
  }

  const oldConnID = pane.connID;
  pane.state = 'pending';
  pane.connID = '';
  pane.pendingMessage = t('terminal.loadingProfile');
  renderTabs();
  setTerminalReconnectCallback(oldConnID, null);
  destroyTerminal(oldConnID);
  if (activeTab === tab) renderTerminalState(tab, pane);

  try {
    console.log('[reconnect] fetching session', pane.sessionID);
    const sess = await getSession(pane.sessionID);
    console.log('[reconnect] session fetched', { found: !!sess, host: sess?.host, authType: sess?.auth_type });
    if (!sess) throw new Error(t('terminal.profileNotFound'));
    pane.sess = { ...sess };
    tab.sessionLabel = sess.label || sess.host;
    tab.host = sess.host;
    tab.username = sess.username;
    if (!tabs.includes(tab) || pane.closed || pane.state !== 'pending') {
      console.log('[reconnect] pane gone or state changed after getSession - aborting');
      return;
    }
    await connectRemotePane(tab, pane);
  } catch (e) {
    console.error('[reconnect] reconnect failed', e);
    if (tabs.includes(tab) && !pane.closed && pane.state === 'pending') failTerminalPane(tab, pane, e);
  }
}

async function handleLocalConnectionClosed(tab, pane, connID) {
  console.log('[local-reconnect] handleLocalConnectionClosed', { connID, paneState: pane?.state, tabInList: tabs.includes(tab) });
  if (!tabs.includes(tab) || pane?.connID !== connID || pane.state !== 'connected') {
    console.log('[local-reconnect] guard rejected');
    return;
  }

  off('terminal:closed:' + connID);
  setTerminalInputEnabled(connID, false);
  setTerminalReconnectCallback(connID, () => {
    const found = findTerminalPaneByConn(connID);
    if (found?.pane.state === 'disconnected') reconnectLocalPane(found.tab, found.pane);
  });
  console.log('[local-reconnect] pane marked disconnected', { connID });
  const cleanup = disconnect(connID).catch(() => {});

  pane.state = 'disconnected';
  pane.error = '';
  pane.pendingMessage = '';
  syncSessionStatus(pane.sessionID);
  writeTerminalLine(connID, t('terminal.pressEnterToReconnect'));
  renderTabs();

  if (activeTab === tab && activeTerminalPane(tab) === pane) {
    updateActivePaneUI(tab);
    notifyActiveTerminalChanged();
    focusTerminal(connID);
  } else if (activeTab) {
    updateConnUI(tabForConnActions(activeTab));
  }
  showToast(t('toast.disconnected'));
  await cleanup;
}

async function reconnectLocalPane(tab, pane) {
  console.log('[local-reconnect] reconnectLocalPane called', { paneState: pane?.state, isLocal: pane?.isLocal, connID: pane?.connID });
  if (!tab || !pane?.isLocal || (pane.state !== 'disconnected' && pane.state !== 'failed')) {
    console.log('[local-reconnect] early return from reconnectLocalPane');
    return;
  }

  const oldConnID = pane.connID;
  pane.connID = '';
  setTerminalReconnectCallback(oldConnID, null);
  try { destroyTerminal(oldConnID); } catch (e) { console.warn('[local-reconnect] destroyTerminal error', e); }
  await connectLocalPane(tab, pane);
}

function getTerminalSize(pane = activeTerminalPane()) {
  const el = pane?.terminalContainer || pane?.element || document.getElementById('panel-terminal');
  return {
    cols: Math.floor((el?.clientWidth || 800) / 8),
    rows: Math.floor((el?.clientHeight || 400) / 17),
  };
}

function createPendingTerminalTab(sess) {
  const pane = createTerminalPane(sess);
  const tab = {
    type: 'terminal',
    id: 'tab-pending-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    sessionID: sess.id,
    sessionLabel: sess.label || sess.host,
    host: sess.host,
    username: sess.username,
    panes: [pane],
    activePaneId: pane.id,
    splitDirection: null,
    splitRatio: 0.5,
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
  tab.sizeElId = 'sb-size-' + suffix;

  const content = document.createElement('div');
  content.className = 'terminal-tab-content';
  content.innerHTML = `
    <div class="terminal-main">
      <div class="terminal-panes"></div>
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
          <button class="btn btn-ghost btn-icon ai-back" title="${t('aiSidebar.back')}" aria-label="${t('aiSidebar.back')}" style="display:none;">←</button>
          <div class="ai-sidebar-heading">
            <div class="ai-sidebar-title">${t('aiSidebar.title')}</div>
            <div class="ai-sidebar-subtitle"></div>
          </div>
          <button class="btn btn-ghost btn-icon ai-history" title="${t('aiSidebar.history')}" aria-label="${t('aiSidebar.history')}">☰</button>
          <button class="btn btn-ghost btn-icon ai-new" title="${t('aiSidebar.newChat')}" aria-label="${t('aiSidebar.newChat')}">＋</button>
          <button class="btn btn-ghost btn-icon ai-close" title="${t('common.close')}" aria-label="${t('common.close')}">×</button>
        </div>
        <div class="ai-session-list" style="display:none;"></div>
        <div class="ai-chat-view" style="display:none;"></div>
      </div>
    </aside>`;

  tab.terminalContent = content;
  tab.panesEl = content.querySelector('.terminal-panes');
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
    historyBtn: content.querySelector('.ai-history'),
    newBtn: content.querySelector('.ai-new'),
    titleEl: content.querySelector('.ai-sidebar-title'),
    subtitleEl: content.querySelector('.ai-sidebar-subtitle'),
    closeBtn: content.querySelector('.ai-close'),
  }, {
    getConnID: () => activeTab === tab ? (activeConnectedPane(tab)?.connID || '') : '',
    getTerminalMeta: () => {
      const pane = activeTerminalPane(tab);
      const connID = pane?.connID || '';
      return {
        label: pane?.sessionLabel || tab.sessionLabel || t('aiSidebar.terminalContext'),
        host: pane?.isLocal ? t('aiSidebar.localTerminal') : (pane?.host || tab.host || ''),
        cwd: connID ? (getTerminalCWD(connID) || '') : '',
        model: settings?.ai_model || '',
      };
    },
    getTerminalSelection: () => {
      const connID = activeConnectedPane(tab)?.connID || '';
      return connID ? getTerminalSelection(connID) : '';
    },
    getTerminalRecentOutput: () => {
      const connID = activeConnectedPane(tab)?.connID || '';
      return connID ? getTerminalRecentOutput(connID) : '';
    },
    onResizeStart: () => suspendTerminalAutoFit(true),
    onResizeEnd: () => suspendTerminalAutoFit(false),
  });

  panel.appendChild(content);
  terminalPanes(tab).forEach(pane => ensurePaneElement(tab, pane));
  renderPaneLayout(tab);
}

function ensurePaneElement(tab, pane) {
  if (pane.element) return pane.element;
  const suffix = pane.id.replace(/[^a-zA-Z0-9_-]/g, '-');
  pane.terminalContainerId = 'terminal-container-' + suffix;

  const element = document.createElement('section');
  element.className = 'terminal-pane';
  element.dataset.paneId = pane.id;
  element.innerHTML = `
    <button class="terminal-pane-close" title="${t('terminal.closePane')}" aria-label="${t('terminal.closePane')}">✕</button>
    <div class="terminal-container" id="${pane.terminalContainerId}"></div>`;
  pane.element = element;
  pane.terminalContainer = element.querySelector('.terminal-container');
  pane.closeButton = element.querySelector('.terminal-pane-close');
  element.addEventListener('pointerdown', () => setActivePane(tab, pane));
  pane.closeButton.addEventListener('pointerdown', e => e.stopPropagation());
  pane.closeButton.addEventListener('click', e => {
    e.stopPropagation();
    closeTerminalPane(tab, pane);
  });
  return element;
}

function renderPaneLayout(tab) {
  if (!tab?.panesEl) return;
  const panes = terminalPanes(tab);
  panes.forEach((pane, index) => {
    const element = ensurePaneElement(tab, pane);
    element.classList.toggle('active', pane.id === tab.activePaneId);
    pane.closeButton.style.display = panes.length > 1 ? '' : 'none';
    if (index === 0 && panes.length > 1) {
      element.style.flex = `0 0 ${(tab.splitRatio || 0.5) * 100}%`;
    } else {
      element.style.flex = '1 1 0';
    }
  });
  tab.panesEl.classList.toggle('split-side-by-side', tab.splitDirection === 'side-by-side');
  tab.panesEl.classList.toggle('split-stacked', tab.splitDirection === 'stacked');
  tab.panesEl.classList.toggle('is-split', panes.length > 1);
  const currentPaneNodes = Array.from(tab.panesEl.children).filter(el => el.classList.contains('terminal-pane'));
  const hasDivider = Array.from(tab.panesEl.children).some(el => el.classList.contains('terminal-split-divider'));
  const needsRebuild = currentPaneNodes.length !== panes.length ||
    currentPaneNodes.some((el, index) => el !== panes[index].element) ||
    hasDivider !== (panes.length > 1);
  if (!needsRebuild) return;

  const nodes = [];
  panes.forEach((pane, index) => {
    nodes.push(pane.element);
    if (index === 0 && panes.length > 1) {
      const divider = document.createElement('div');
      divider.className = 'terminal-split-divider';
      divider.setAttribute('role', 'separator');
      divider.addEventListener('pointerdown', e => beginSplitResize(e, tab));
      nodes.push(divider);
    }
  });
  tab.panesEl.replaceChildren(...nodes);
}

function beginSplitResize(e, tab) {
  if (terminalPanes(tab).length !== 2 || !tab.panesEl) return;
  e.preventDefault();
  e.stopPropagation();
  const divider = e.currentTarget;
  divider.setPointerCapture?.(e.pointerId);
  const rect = tab.panesEl.getBoundingClientRect();
  const isSideBySide = tab.splitDirection === 'side-by-side';
  suspendTerminalAutoFit(true);

  const move = ev => {
    const raw = isSideBySide
      ? (ev.clientX - rect.left) / Math.max(1, rect.width)
      : (ev.clientY - rect.top) / Math.max(1, rect.height);
    tab.splitRatio = Math.min(0.85, Math.max(0.15, raw));
    const first = terminalPanes(tab)[0]?.element;
    if (first) first.style.flexBasis = `${tab.splitRatio * 100}%`;
  };
  const end = () => {
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', end, true);
    document.removeEventListener('pointercancel', end, true);
    suspendTerminalAutoFit(false);
    refitTerminalTab(tab);
  };
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
}

function mountTerminalPane(tab, pane) {
  ensurePaneElement(tab, pane);
  if (pane.state === 'pending' || pane.state === 'failed') {
    renderTerminalState(tab, pane);
    return;
  }
  if (!pane.connID) return;
  pane.terminalContainer?.querySelector('.terminal-state')?.remove();
  createTerminal(pane.connID, settings, {
    containerId: pane.terminalContainerId,
    onFocus: () => setActivePane(tab, pane),
    onSizeChange: (cols, rows) => {
      pane.lastSize = `${cols}×${rows}`;
      if (activeTab === tab && activeTerminalPane(tab) === pane && tab.sizeEl) {
        tab.sizeEl.textContent = pane.lastSize;
      }
    },
  });
  setTerminalInputEnabled(pane.connID, pane.state === 'connected');
}

function setActivePane(tab, pane, { focus = false } = {}) {
  if (!isTerminalTab(tab) || !terminalPanes(tab).includes(pane)) return;
  tab.activePaneId = pane.id;
  terminalPanes(tab).forEach(p => p.element?.classList.toggle('active', p === pane));
  if (activeTab === tab) {
    updateActivePaneUI(tab);
    notifyActiveTerminalChanged();
  }
  if (focus && pane.connID) focusTerminal(pane.connID);
}

function updateActivePaneUI(tab) {
  const pane = activeTerminalPane(tab);
  if (!pane) {
    updateConnUI(null);
    return;
  }
  if (tab.statusEl) {
    tab.statusEl.textContent = pane.state === 'connected' ? t('common.connected')
      : pane.state === 'pending' ? t('terminal.connectingStatus')
      : pane.state === 'failed' ? t('common.failed')
      : t('terminal.disconnectedStatus');
  }
  if (tab.sizeEl) tab.sizeEl.textContent = pane.lastSize || '—';
  updateConnUI(pane.state === 'connected' ? pane : null);
}

function refitTerminalTab(tab, options = {}) {
  terminalPanes(tab).forEach(pane => {
    if (pane.connID) fitTerminal(pane.connID, options);
  });
}

async function splitTerminalTab(tab, direction) {
  if (!isTerminalTab(tab) || terminalPanes(tab).length !== 1 || tab.splitPending) return;
  const source = activeConnectedPane(tab) || terminalPanes(tab).find(p => p.state === 'connected');
  if (!source) return;
  tab.splitPending = true;
  await switchToTab(tab);

  let sess;
  try {
    sess = source.isLocal ? { ...source.sess } : await getSession(source.sessionID);
    if (!sess) throw new Error(t('terminal.profileNotFound'));
  } catch (e) {
    showToast(`❌ ${e}`);
    tab.splitPending = false;
    return;
  }
  if (!tabs.includes(tab) || source.closed || terminalPanes(tab).length !== 1) {
    tab.splitPending = false;
    return;
  }

  const pane = createTerminalPane(sess);
  if (source.connID) rememberTerminalViewport(source.connID);
  tab.panes.push(pane);
  tab.splitDirection = direction;
  tab.splitRatio = 0.5;
  ensurePaneElement(tab, pane);
  renderPaneLayout(tab);
  renderTerminalState(tab, pane);
  refitTerminalTab(tab, { restoreScroll: true, caller: 'split-terminal' });
  tab.splitPending = false;
  if (pane.isLocal) await connectLocalPane(tab, pane);
  else await connectRemotePane(tab, pane);
}

function closeTerminalPane(tab, pane) {
  if (!isTerminalTab(tab) || !terminalPanes(tab).includes(pane)) return;
  if (terminalPanes(tab).length === 1) {
    closeTab(tab);
    return;
  }
  pane.closed = true;
  pane.attemptID = -1;
  Object.keys(pendingConnects).forEach(key => {
    if (pendingConnects[key]?.pane === pane) delete pendingConnects[key];
  });
  const connID = pane.connID;
  const activeRelatedSFTP = !!connID && activeTab?.type === 'sftp' && activeTab.connID === connID;
  if (connID) {
    off('terminal:closed:' + connID);
    disconnect(connID).catch(e => console.warn('disconnect:', e));
    destroyTerminal(connID);
    tabs = tabs.filter(t => !(t.type === 'sftp' && t.connID === connID));
  }
  pane.element?.remove();
  pane.element = null;
  pane.terminalContainer = null;
  tab.panes = terminalPanes(tab).filter(p => p !== pane);
  tab.splitDirection = null;
  tab.splitRatio = 0.5;
  const remaining = terminalPanes(tab)[0];
  if (remaining.connID) rememberTerminalViewport(remaining.connID);
  tab.activePaneId = remaining.id;
  renderPaneLayout(tab);
  renderTabs();
  syncSessionStatus(pane.sessionID);
  if (activeRelatedSFTP) {
    switchToTab(tab);
  } else {
    setActivePane(tab, remaining, { focus: activeTab === tab });
  }
  refitTerminalTab(tab, { restoreScroll: true, caller: 'close-split-pane' });
}

function failTerminalPane(tab, pane, err) {
  if (!tab || !pane || pane.closed) return;
  Object.keys(pendingConnects).forEach(key => {
    if (pendingConnects[key]?.pane === pane) delete pendingConnects[key];
  });
  pane.state = 'failed';
  pane.error = String(err?.message || err || t('terminal.unknownError'));
  pane.pendingMessage = '';
  syncSessionStatus(pane.sessionID);
  renderTabs();
  if (activeTab === tab) renderTerminalState(tab, pane);
  showToast(`❌ ${pane.error}`);
}

function renderTerminalState(tab, pane) {
  ensureTerminalContent(tab);
  ensurePaneElement(tab, pane);
  const container = pane.terminalContainer;
  if (!container) return;
  container.innerHTML = '';
  const isFailed = pane.state === 'failed';
  const detail = formatSessionEndpoint(pane.sess || pane);
  const message = isFailed
    ? pane.error
    : (pane.pendingMessage || t('terminal.connectingTo', { host: pane.host || pane.sessionLabel }));

  const state = document.createElement('div');
  state.className = 'terminal-state' + (isFailed ? ' failed' : '');
  state.innerHTML = `
    <div class="terminal-state-card">
      <div class="terminal-state-icon">${isFailed ? '!' : ''}</div>
      <div class="terminal-state-title">${escHtml(isFailed ? t('terminal.connectionFailedTitle') : t('terminal.connectingTitle'))}</div>
      <div class="terminal-state-sub">${escHtml(pane.sessionLabel || '')}</div>
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

  if (activeTab === tab && activeTerminalPane(tab) === pane) updateActivePaneUI(tab);

  if (isFailed) {
    state.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
      if (pane.isLocal) reconnectLocalPane(tab, pane);
      else connectRemotePane(tab, pane);
    });
    state.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
      if (pane.isLocal) return;
      openProfileForm(pane.sess, (saved) => {
        loadProfiles();
        pane.sess = { ...saved };
        pane.sessionID = saved.id;
        pane.sessionLabel = saved.label || saved.host;
        pane.host = saved.host;
        pane.username = saved.username;
        tab.sessionID = saved.id;
        tab.sessionLabel = saved.label || saved.host;
        tab.host = saved.host;
        tab.username = saved.username;
        renderTabs();
        if (activeTab === tab) renderTerminalState(tab, pane);
      });
    });
    const editBtn = state.querySelector('[data-action="edit"]');
    if (editBtn && pane.isLocal) editBtn.style.display = 'none';
    state.querySelector('[data-action="close"]')?.addEventListener('click', () => closeTerminalPane(tab, pane));
  }
}

function formatSessionEndpoint(sess) {
  const user = sess.username ? `${sess.username}@` : '';
  const host = sess.host || sess.sessionLabel || '';
  const port = sess.port || 22;
  return `${user}${host}${host ? ':' + port : ''}`;
}

function doDisconnect(connID) {
  if (!connID) return;
  const found = findTerminalPaneByConn(connID);
  if (!found) return;
  if (terminalPanes(found.tab).length > 1) closeTerminalPane(found.tab, found.pane);
  else closeTab(found.tab);
  showToast(t('toast.disconnected'));
}

// ── Tab management ────────────────────────────────────────────────────────────

function terminalTabVisualState(tab) {
  const states = terminalPanes(tab).map(p => p.state);
  if (states.includes('connected')) return 'connected';
  if (states.includes('pending')) return 'connecting';
  if (states.includes('failed')) return 'failed';
  return 'disconnected';
}

function renderTabs() {
  const scroll = document.getElementById('tabs-scroll');
  scroll.innerHTML = '';
  tabs.forEach((tab, idx) => {
    const isSettings = tab.type === 'settings';
    const isSFTP = tab.type === 'sftp';
    const terminalState = isTerminalTab(tab) ? terminalTabVisualState(tab) : '';
    const isFailed = terminalState === 'failed';
    const el = document.createElement('div');
    el.className = 'tab' + (tab === activeTab ? ' active' : '') + (isFailed ? ' failed' : '');
    el.dataset.tabId = tab.id;
    el.innerHTML = `
      ${isSettings ? '<span class="tab-icon">⚙</span>' : isSFTP ? '<span class="tab-icon">📁</span>' : `<div class="status-dot ${terminalState}" style="width:6px;height:6px;"></div>`}
      <span>${escHtml(tab.sessionLabel)}</span>
      <span class="tab-num">${idx + 1}</span>
      <button class="tab-close">✕</button>`;
    el.addEventListener('click', e => {
      if (e.target.classList.contains('tab-close')) { closeTab(tab); return; }
      switchToTab(tab);
    });
    if (isTerminalTab(tab)) {
      el.addEventListener('contextmenu', e => showTerminalTabContextMenu(e, tab));
    }
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

function showTerminalTabContextMenu(e, tab) {
  e.preventDefault();
  e.stopPropagation();
  document.querySelectorAll('.ctx-menu').forEach(menu => menu.remove());
  const canSplit = terminalPanes(tab).length === 1 && terminalPanes(tab)[0]?.state === 'connected';
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const items = [
    { label: t('terminal.splitSideBySide'), direction: 'side-by-side' },
    { label: t('terminal.splitStacked'), direction: 'stacked' },
  ];
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'ctx-item' + (canSplit ? '' : ' disabled');
    const icon = document.createElement('span');
    icon.className = `split-menu-icon ${item.direction}`;
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = item.label;
    el.append(icon, label);
    el.addEventListener('click', () => {
      if (!canSplit) return;
      menu.remove();
      splitTerminalTab(tab, item.direction);
    });
    menu.appendChild(el);
  });
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - rect.height - 4))}px`;
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
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
  if (isTerminalTab(activeTab)) {
    terminalPanes(activeTab).forEach(pane => pane.connID && rememberTerminalViewport(pane.connID));
  }
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
  if (!isTerminalTab(tab)) return;
  activeTab = tab;
  ensureTerminalContent(tab);
  renderPaneLayout(tab);
  updateActiveTabClass();
  showPanel('terminal');
  showTerminalContent(tab, previousTab);
  perfLog('after showTerminalContent', (performance.now() - switchStartedAt).toFixed(1) + 'ms');
  terminalPanes(tab).forEach(pane => mountTerminalPane(tab, pane));
  perfLog('after createTerminal', (performance.now() - switchStartedAt).toFixed(1) + 'ms');
  const pane = activeTerminalPane(tab);
  setActivePane(tab, pane, { focus: !!pane?.connID });
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
  if (isTerminalTab(tab)) closeTerminalTab(tab);
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

function closeTerminalTab(tab) {
  const panes = [...terminalPanes(tab)];
  const connIDs = new Set(panes.map(p => p.connID).filter(Boolean));
  const activeRelatedSFTP = activeTab?.type === 'sftp' && connIDs.has(activeTab.connID);
  const wasActive = tab === activeTab || activeRelatedSFTP;
  const closedIndex = Math.max(0, tabs.indexOf(wasActive ? activeTab : tab));
  const sessionIDs = new Set(panes.map(p => p.sessionID).filter(Boolean));
  panes.forEach(pane => {
    pane.closed = true;
    pane.attemptID = -1;
    Object.keys(pendingConnects).forEach(key => {
      if (pendingConnects[key]?.pane === pane) delete pendingConnects[key];
    });
    if (pane.connID) {
      off('terminal:closed:' + pane.connID);
      disconnect(pane.connID).catch(e => console.warn('disconnect:', e));
      destroyTerminal(pane.connID);
    }
  });
  tabs = tabs.filter(t => t !== tab);
  tabs = tabs.filter(t => !(t.type === 'sftp' && connIDs.has(t.connID)));
  destroyTerminalContent(tab);
  renderTabs();
  if (wasActive) activateFallbackTab(closedIndex);
  sessionIDs.forEach(syncSessionStatus);
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
  return !!tab && tab.type === 'terminal' && Array.isArray(tab.panes);
}

function isAITerminalTab(tab) {
  return isTerminalTab(tab);
}

function hasTerminalConn(tab) {
  if (isTerminalTab(tab)) return !!activeConnectedPane(tab)?.connID;
  return !!tab && tab.type === 'sftp' && !!tab.connID;
}

function tabForConnActions(tab) {
  if (isTerminalTab(tab)) return activeConnectedPane(tab);
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
  tab.panesEl = null;
  terminalPanes(tab).forEach(pane => {
    pane.element = null;
    pane.terminalContainer = null;
    pane.closeButton = null;
  });
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
    refitTerminalTab(activeTab, { ...options, caller: 'refitActiveTerminal-RAF' });
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
  const target = tabForConnActions(activeTab);
  if (!target?.connID) { showToast(t('toast.connectFirst')); return; }
  if (target.isLocal) { showToast(t('toast.sftpRemoteOnly')); return; }
  const connID = target.connID;
  let tab = tabs.find(t => t.type === 'sftp' && t.connID === connID);
  if (!tab) {
    tab = {
      type: 'sftp',
      id: 'tab-sftp-' + connID,
      connID,
      sessionID: target.sessionID,
      sessionLabel: `SFTP: ${target.sessionLabel}`,
      host: target.host,
      username: target.username,
      isLocal: target.isLocal,
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
  if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    e.stopPropagation();
    toggleAISidebar();
    return;
  }
  const pane = activeTerminalPane();
  if (e.key === 'Enter') {
    console.log('[reconnect] Enter keydown', { activeTabType: activeTab?.type, paneState: pane?.state, isLocal: pane?.isLocal, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
  }
  const noMod = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
  const fromAISidebar = !!e.target?.closest?.('.ai-sidebar');
  if (e.key === 'Enter' && noMod && !fromAISidebar &&
      (pane?.state === 'disconnected' || pane?.state === 'failed')) {
    console.log('[reconnect] triggering reconnect from handleKeydown', { state: pane.state });
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    if (pane.isLocal) reconnectLocalPane(activeTab, pane);
    else if (pane.state === 'disconnected') reconnectRemotePane(activeTab, pane);
    else if (pane.sess) connectRemotePane(activeTab, pane);
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
  const pane = activeConnectedPane();
  if (!pane) return;
  sendInput(pane.connID, '\x1b').catch(e => console.error('nativeEsc sendInput:', e));
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
    if (pending) failTerminalPane(pending.tab, pending.pane, t('terminal.hostKeyRejected'));
    showToast(t('toast.connectionRejected'));
  };

  document.getElementById('hostkey-once').onclick = async () => {
    close();
    const pending = findPendingConnect(session_id, hostname);
    if (!pending) { showToast(t('toast.noPendingConnection')); return; }
    delete pendingConnects[pending.attemptID];
    await connectRemotePane(pending.tab, pending.pane, { skip_host_key_check: true });
  };

  document.getElementById('hostkey-always').onclick = async () => {
    close();
    const pending = findPendingConnect(session_id, hostname);
    if (!pending) { showToast(t('toast.noPendingConnection')); return; }
    delete pendingConnects[pending.attemptID];
    try {
      await acceptHostKey(hostname);
    } catch (e) {
      showToast(t('toast.hostKeySaveFailed', { e }));
    }
    await connectRemotePane(pending.tab, pending.pane, { skip_host_key_check: true });
  };
}

function findPendingConnect(sessionID, hostname) {
  return Object.values(pendingConnects).find(({ sess }) => {
    if (sessionID && sess.id !== sessionID) return false;
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
