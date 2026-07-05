import {
  listAIChatSessionsForTarget, createAIChatSession, renameAIChatSession, deleteAIChatSession,
  getAIChatMessages, sendAIMessage, retryAIMessage, approveAIToolCall, rejectAIToolCall, setAIAutoExec,
  stopAIRun, isAIRunActive, on, off,
} from './api.js';
import { t } from './i18n.js';
import { showToast } from './toast.js';
import { renderMarkdown } from './markdown.js';
import { confirmDialog } from './confirm-dialog.js';

let getActiveTab = () => null;
let aiEnabled = false;
let aiSettings = {};
let activeInstance = null;
let selectionAction = null;
let selectionDismiss = null;
let selectionListenerTimer = 0;
let selectionExpiryTimer = 0;
const PERF_DEBUG = false;

function perfLog(label, ...args) {
  if (PERF_DEBUG) console.log('[PERF-AI]', label, ...args);
}

const MIN_SIDEBAR_WIDTH = 240;
const DEFAULT_SIDEBAR_WIDTH = 320;

export function initAISidebar(settings, activeTabGetter) {
  getActiveTab = activeTabGetter;
  setAISidebarSettings(settings);
  document.getElementById('btn-toggle-ai')?.addEventListener('click', toggleAISidebar);
  window.addEventListener('resize', () => activeInstance?.applySidebarWidth());
  window.addEventListener('ishell:terminalSelection', e => showSelectionAction(e.detail));
  window.addEventListener('ishell:terminalAIAction', e => runQuickAIAction(e.detail));
}

async function runQuickAIAction({ kind, text, sourceKind } = {}) {
  if (!aiEnabled || !text || !activeInstance) return;
  const instance = activeInstance;
  dismissSelectionAction();
  instance.setOpen(true, { animate: true, notify: true });
  if (!instance.currentChatID) await instance.handleNewChat();
  if (!instance.currentChatID) return;

  const label = sourceKind === 'terminal_selection' ? t('aiSidebar.selectedTerminalText') : t('aiSidebar.recentTerminalOutput');

  if (kind === 'ask') {
    instance.addContext(sourceKind, label, text);
    instance.focusInput();
    return;
  }

  const prompt = kind === 'fix' ? t('aiSidebar.fixPrompt') : t('aiSidebar.explainPrompt');
  const contexts = [{ kind: sourceKind, label, content: text }];
  if (!await instance.confirmContextAutoExec(contexts)) return;
  instance.appendUserBubble(prompt, contexts);
  await instance.sendUnpersistedPrompt(instance.currentChatID, prompt, contexts);
}

function dismissSelectionAction() {
  selectionAction?.remove();
  selectionAction = null;
  if (selectionDismiss) document.removeEventListener('pointerdown', selectionDismiss, true);
  selectionDismiss = null;
  if (selectionListenerTimer) clearTimeout(selectionListenerTimer);
  if (selectionExpiryTimer) clearTimeout(selectionExpiryTimer);
  selectionListenerTimer = 0;
  selectionExpiryTimer = 0;
}

function showSelectionAction(detail) {
  dismissSelectionAction();
  if (!aiEnabled || !detail?.text || !activeInstance) return;
  const button = document.createElement('button');
  button.className = 'ai-selection-action';
  button.textContent = t('aiSidebar.askAI');
  button.style.left = Math.min(window.innerWidth - 100, Math.max(8, detail.x + 8)) + 'px';
  button.style.top = Math.min(window.innerHeight - 40, Math.max(8, detail.y + 8)) + 'px';
  button.addEventListener('click', async () => {
    const instance = activeInstance;
    instance.setOpen(true, { animate: true, notify: true });
    if (!instance.currentChatID) await instance.handleNewChat();
    if (!instance.currentChatID) {
      dismissSelectionAction();
      return;
    }
    instance.addContext('terminal_selection', t('aiSidebar.selectedTerminalText'), detail.text);
    instance.focusInput();
    dismissSelectionAction();
  });
  document.body.appendChild(button);
  selectionAction = button;
  selectionDismiss = e => {
    if (e.target === button) return;
    dismissSelectionAction();
  };
  selectionListenerTimer = setTimeout(() => {
    selectionListenerTimer = 0;
    if (selectionAction === button) document.addEventListener('pointerdown', selectionDismiss, true);
  }, 0);
  selectionExpiryTimer = setTimeout(dismissSelectionAction, 8000);
}

export function setAISidebarSettings(settings) {
  aiSettings = settings || {};
  aiEnabled = !!settings?.ai_enabled;
  if (!aiEnabled) {
    dismissSelectionAction();
    activeInstance?.setOpen(false, { animate: true, notify: true });
  }
  activeInstance?.updateHeader();
  updateToolbarButton();
}

export function createAISidebarForTab(tab, els, options = {}) {
  if (tab.aiSidebar) return tab.aiSidebar;
  tab.aiSidebar = new AISidebarInstance(tab, els, options);
  return tab.aiSidebar;
}

export function activateAISidebarForTab(tab) {
  if (activeInstance && activeInstance !== tab?.aiSidebar) activeInstance.deactivate();
  activeInstance = tab?.aiSidebar || null;
  activeInstance?.activate();
  updateToolbarButton();
}

export function deactivateAISidebar() {
  activeInstance?.deactivate();
  activeInstance = null;
  updateToolbarButton();
}

export function suspendAISidebarLayout(tab) {
  tab?.aiSidebar?.suspendLayout();
}

export function destroyAISidebarForTab(tab) {
  if (!tab?.aiSidebar) return;
  if (activeInstance === tab.aiSidebar) activeInstance = null;
  tab.aiSidebar.destroy();
  tab.aiSidebar = null;
  updateToolbarButton();
}

export function notifyActiveTerminalChanged() {
  updateToolbarButton();
  activeInstance?.syncTarget();
}

export function toggleAISidebar() {
  activeInstance?.toggleByUser();
}

function updateToolbarButton() {
  const show = aiEnabled && !!activeInstance && activeInstance.isTerminalActive();
  const btn = document.getElementById('btn-toggle-ai');
  const vdiv = document.getElementById('ai-toolbar-vdiv');
  if (btn) btn.style.display = show ? '' : 'none';
  if (vdiv) vdiv.style.display = show ? '' : 'none';
}

function maxSidebarWidth() {
  return Math.max(1, Math.floor(window.innerWidth * 2 / 3));
}

function clampSidebarWidth(width) {
  const max = maxSidebarWidth();
  const min = Math.min(MIN_SIDEBAR_WIDTH, max);
  return Math.min(max, Math.max(min, width));
}

function savedSidebarWidth(tab) {
  const key = tab?.id ? 'ai-sidebar-width-' + tab.id : 'ai-sidebar-width';
  try {
    const perTab = parseInt(localStorage.getItem(key), 10);
    if (perTab >= MIN_SIDEBAR_WIDTH) return clampSidebarWidth(perTab);
    const saved = parseInt(localStorage.getItem('ai-sidebar-width'), 10);
    if (saved >= MIN_SIDEBAR_WIDTH) return clampSidebarWidth(saved);
  } catch { /* ignore */ }
  return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
}

function saveSidebarWidth(tab, width) {
  try {
    localStorage.setItem('ai-sidebar-width-' + tab.id, String(width));
    localStorage.setItem('ai-sidebar-width', String(width));
  } catch { /* ignore */ }
}

class AISidebarInstance {
  constructor(tab, els, options) {
    this.tab = tab;
    this.root = els.root;
    this.inner = els.inner;
    this.resizer = els.resizer;
    this.listEl = els.listEl;
    this.chatEl = els.chatEl;
    this.backBtn = els.backBtn;
    this.historyBtn = els.historyBtn;
    this.newBtn = els.newBtn;
    this.titleEl = els.titleEl;
    this.subtitleEl = els.subtitleEl;
    this.closeBtn = els.closeBtn;
    this.getConnID = options.getConnID || (() => '');
    this.getTerminalMeta = options.getTerminalMeta || (() => ({}));
    this.getTerminalSelection = options.getTerminalSelection || (() => '');
    this.getTerminalRecentOutput = options.getTerminalRecentOutput || (() => '');
    this.onLayoutChange = options.onLayoutChange || (() => {});
    this.onResizeStart = options.onResizeStart || (() => {});
    this.onResizeEnd = options.onResizeEnd || (() => {});

    this.currentTargetID = null;
    this.chatsForTarget = [];
    this.currentChatID = null;
    this.lastRenderedSignature = null;
    this.currentAutoExec = false;
    this.currentAssistantBubble = null;
    this.currentAssistantRaw = '';
    this.isSending = false;
    this.stopRequested = false;
    this.userNearBottom = true;
    this.pendingContexts = [];
    this.lastFailedPrompt = null;
    this.isConfirmingSend = false;
    this.markdownFrame = 0;
    this.cardsByToolCallID = {};
    this.confirmingDeleteID = null;
    this.unsubscribers = [];
    this.cleanupResizerDrag = null;
    this.pendingInnerHideListener = null;
    this.pendingLayoutChangeListener = null;
    this.pendingLayoutChangeTimer = 0;
    this.pendingInnerShowRAFs = [];
    this.destroyed = false;
    this.active = false;

    this.backBtn?.addEventListener('click', () => this.showSessionList());
    this.historyBtn?.addEventListener('click', () => this.showSessionList());
    this.newBtn?.addEventListener('click', () => this.handleNewChat());
    this.closeBtn?.addEventListener('click', () => this.setOpen(false, { animate: true, notify: true }));
    this.updateHeader();
    this.initResizer();
    this.applySidebarWidth();
    this.setOpen(!!this.tab.aiSidebarOpen, { animate: false, notify: false, deferInnerRestore: true });
  }

  isTerminalActive() {
    return getActiveTab() === this.tab;
  }

  activate() {
    if (this.destroyed) return;
    const startedAt = performance.now();
    perfLog('activate start', {
      tab: this.tab.id,
      open: !!this.tab.aiSidebarOpen,
      collapsed: this.root?.classList.contains('collapsed'),
      currentChatID: this.currentChatID,
      messageNodes: this.messagesEl?.children.length || 0,
    });
    this.active = true;
    this.updateHeader();
    if (!aiEnabled) {
      this.setOpen(false, { animate: false, notify: false });
      return;
    }
    this.setOpen(!!this.tab.aiSidebarOpen, { animate: false, notify: false, deferInnerRestore: true });
    const targetBeforeSync = this.currentTargetID;
    this.syncTarget();
    if (this.currentTargetID && this.currentTargetID === targetBeforeSync) {
      if (this.currentChatID) {
        const chatID = this.currentChatID;
        this.subscribeChatEvents(chatID);
        if (this.isSending) {
          // AI was running when this tab was deactivated — re-sync missed events.
          this.refreshCurrentChat(chatID).finally(async () => {
            if (!this.active || this.currentChatID !== chatID) return;
            let running = false;
            try { running = await isAIRunActive(chatID); } catch { /* default to false */ }
            if (this.active && this.currentChatID === chatID) this.setSending(running);
          });
        }
        // If AI was not running, DOM state is already correct — no refresh needed.
      }
      // Session list state is preserved in DOM — no refresh needed on reactivation.
    }
    perfLog('activate done', this.tab.id, (performance.now() - startedAt).toFixed(1) + 'ms');
  }

  deactivate() {
    this.active = false;
    this.unsubscribeChatEvents();
  }

  suspendLayout() {
    this.setInnerHidden(true);
  }

  destroy() {
    this.destroyed = true;
    this.unsubscribeChatEvents();
    this.cancelPendingInnerHide();
    this.cancelPendingLayoutChange();
    this.cancelPendingInnerShow();
    this.cleanupResizerDrag?.();
    this.cleanupResizerDrag = null;
    if (this.markdownFrame) cancelAnimationFrame(this.markdownFrame);
  }

  syncTarget() {
    if (!this.active || !this.isTerminalActive() || !aiEnabled) return;
    const newTargetID = this.tab.sessionID || null;
    this.updateHeader();
    if (newTargetID === this.currentTargetID) return;
    this.currentTargetID = newTargetID;
    this.leaveChat();
    if (this.currentTargetID) this.loadForTarget(this.currentTargetID);
  }

  toggleByUser() {
    const opening = this.root.classList.contains('collapsed');
    this.setOpen(opening, { animate: true, notify: true });
    if (opening) requestAnimationFrame(() => this.focusInput());
  }

  focusInput() {
    if (this.isOpen()) this.inputEl?.focus();
  }

  updateHeader() {
    const meta = this.getTerminalMeta?.() || {};
    const sess = this.chatsForTarget.find(s => s.id === this.currentChatID);
    if (this.titleEl) this.titleEl.textContent = sess?.title || t('aiSidebar.title');
    const parts = [meta.host || meta.label, meta.cwd, meta.model || aiSettings.ai_model].filter(Boolean);
    if (this.subtitleEl) {
      this.subtitleEl.textContent = parts.join(' · ');
      this.subtitleEl.title = parts.join('\n');
    }
    if (this.historyBtn) this.historyBtn.style.display = this.currentChatID ? '' : 'none';
  }

  isOpen() {
    return !!this.root && !this.root.classList.contains('collapsed');
  }

  setOpen(open, { animate, notify, deferInnerRestore = false } = {}) {
    if (!this.root) return;
    const startedAt = performance.now();
    perfLog('setOpen start', { tab: this.tab.id, open, animate, notify, deferInnerRestore });
    const wasOpen = !this.root.classList.contains('collapsed');
    const layoutChanging = !!notify && wasOpen !== open;
    this.tab.aiSidebarOpen = !!open;
    this.cancelPendingInnerHide();
    this.cancelPendingLayoutChange();
    this.cancelPendingInnerShow();
    if (layoutChanging) this.onResizeStart();
    if (!animate) this.root.classList.add('no-transition');
    // .ai-sidebar-inner keeps a fixed width while collapsed so chat text does
    // not re-wrap mid-transition. content-visibility removes inactive history
    // from layout until the sidebar is opened again.
    if (open && this.inner) {
      if (deferInnerRestore) {
        this.scheduleInnerShow(startedAt);
      } else {
        const innerStartedAt = performance.now();
        this.setInnerHidden(false);
        perfLog('setOpen after setInnerHidden(false)', this.tab.id, (performance.now() - innerStartedAt).toFixed(1) + 'ms');
      }
    }
    const toggleStartedAt = performance.now();
    this.root.classList.toggle('collapsed', !open);
    perfLog('setOpen after classList.toggle', this.tab.id, (performance.now() - toggleStartedAt).toFixed(1) + 'ms');
    const widthStartedAt = performance.now();
    this.applySidebarWidth();
    perfLog('setOpen after applySidebarWidth', this.tab.id, (performance.now() - widthStartedAt).toFixed(1) + 'ms');
    if (this.resizer) this.resizer.style.display = open ? '' : 'none';
    if (!animate) requestAnimationFrame(() => this.root?.classList.remove('no-transition'));
    if (!open) this.scheduleInnerHide(animate);
    if (open && !wasOpen) {
      perfLog('setOpen before ensureOpenContent', this.tab.id, (performance.now() - startedAt).toFixed(1) + 'ms');
      this.ensureOpenContent().finally(() => {
        perfLog('setOpen ensureOpenContent done', this.tab.id, (performance.now() - startedAt).toFixed(1) + 'ms');
        if (this.isOpen()) this.focusInput();
      });
    }
    if (layoutChanging) this.scheduleLayoutChange(!!animate);
    perfLog('setOpen done', this.tab.id, (performance.now() - startedAt).toFixed(1) + 'ms');
    if (open && !deferInnerRestore) {
      requestAnimationFrame(() => {
        const frameStartedAt = performance.now();
        const rect = this.inner?.getBoundingClientRect();
        const scrollHeight = this.messagesEl?.scrollHeight || 0;
        perfLog('setOpen next RAF layout read', {
          tab: this.tab.id,
          elapsed: (performance.now() - startedAt).toFixed(1) + 'ms',
          readCost: (performance.now() - frameStartedAt).toFixed(1) + 'ms',
          innerWidth: rect?.width || 0,
          innerHeight: rect?.height || 0,
          messageNodes: this.messagesEl?.children.length || 0,
          scrollHeight,
        });
      });
    }
  }

  setInnerHidden(hidden) {
    if (!this.inner) return;
    this.inner.style.contentVisibility = hidden ? 'hidden' : '';
    this.inner.style.pointerEvents = hidden ? 'none' : '';
    this.inner.style.visibility = '';
    if (hidden) this.inner.setAttribute('aria-hidden', 'true');
    else this.inner.removeAttribute('aria-hidden');
  }

  scheduleInnerShow(startedAt) {
    perfLog('scheduleInnerShow deferred', this.tab.id);
    const first = requestAnimationFrame(() => {
      const second = requestAnimationFrame(() => {
        if (this.destroyed || !this.active || !this.isTerminalActive() || !this.isOpen()) return;
        const innerStartedAt = performance.now();
        this.setInnerHidden(false);
        perfLog('deferred setInnerHidden(false)', {
          tab: this.tab.id,
          elapsed: (performance.now() - startedAt).toFixed(1) + 'ms',
          cost: (performance.now() - innerStartedAt).toFixed(1) + 'ms',
        });
        requestAnimationFrame(() => {
          const frameStartedAt = performance.now();
          const rect = this.inner?.getBoundingClientRect();
          const scrollHeight = this.messagesEl?.scrollHeight || 0;
          perfLog('deferred inner next RAF layout read', {
            tab: this.tab.id,
            elapsed: (performance.now() - startedAt).toFixed(1) + 'ms',
            readCost: (performance.now() - frameStartedAt).toFixed(1) + 'ms',
            innerWidth: rect?.width || 0,
            innerHeight: rect?.height || 0,
            messageNodes: this.messagesEl?.children.length || 0,
            scrollHeight,
          });
        });
      });
      this.pendingInnerShowRAFs.push(second);
    });
    this.pendingInnerShowRAFs.push(first);
  }

  cancelPendingInnerShow() {
    this.pendingInnerShowRAFs.splice(0).forEach(id => cancelAnimationFrame(id));
  }

  scheduleLayoutChange(waitForTransition) {
    this.cancelPendingLayoutChange();
    const finish = () => {
      this.cancelPendingLayoutChange();
      this.onResizeEnd();
      this.onLayoutChange();
    };
    if (!waitForTransition) {
      finish();
      return;
    }
    const onEnd = (e) => {
      if (e.target !== this.root || e.propertyName !== 'width') return;
      finish();
    };
    this.pendingLayoutChangeListener = onEnd;
    this.root.addEventListener('transitionend', onEnd);
    this.pendingLayoutChangeTimer = setTimeout(finish, 320);
  }

  cancelPendingLayoutChange() {
    if (this.pendingLayoutChangeListener) {
      this.root?.removeEventListener('transitionend', this.pendingLayoutChangeListener);
      this.pendingLayoutChangeListener = null;
    }
    if (this.pendingLayoutChangeTimer) {
      clearTimeout(this.pendingLayoutChangeTimer);
      this.pendingLayoutChangeTimer = 0;
    }
  }

  scheduleInnerHide(animate) {
    if (!this.inner) return;
    if (!animate) {
      this.setInnerHidden(true);
      return;
    }
    const onEnd = (e) => {
      if (e.target !== this.root || e.propertyName !== 'width') return;
      this.cancelPendingInnerHide();
      if (this.root?.classList.contains('collapsed') && this.inner) {
        this.setInnerHidden(true);
      }
    };
    this.pendingInnerHideListener = onEnd;
    this.root.addEventListener('transitionend', onEnd);
  }

  cancelPendingInnerHide() {
    if (this.pendingInnerHideListener) {
      this.root?.removeEventListener('transitionend', this.pendingInnerHideListener);
      this.pendingInnerHideListener = null;
    }
  }

  applySidebarWidth() {
    const width = savedSidebarWidth(this.tab);
    if (this.root) this.root.style.width = this.root.classList.contains('collapsed') ? '0px' : width + 'px';
    if (this.inner) this.inner.style.width = width + 'px';
  }

  initResizer() {
    if (!this.resizer || !this.root) return;
    this.resizer.tabIndex = 0;
    this.resizer.setAttribute('role', 'separator');
    this.resizer.setAttribute('aria-orientation', 'vertical');
    this.resizer.setAttribute('aria-label', t('aiSidebar.resize'));
    let startX = 0;
    let startWidth = 0;
    let resizing = false;
    const commitWidth = () => {
      const width = clampSidebarWidth(parseInt(this.root.style.width, 10) || this.root.getBoundingClientRect().width);
      this.root.style.width = width + 'px';
      if (this.inner) this.inner.style.width = width + 'px';
      saveSidebarWidth(this.tab, width);
    };
    const onMouseMove = (e) => {
      const next = clampSidebarWidth(startWidth + (startX - e.clientX));
      this.root.style.width = next + 'px';
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      this.root.classList.remove('resizing');
      commitWidth();
      if (resizing) {
        resizing = false;
        this.onResizeEnd();
      }
      this.cleanupResizerDrag = null;
      this.onLayoutChange();
    };
    this.resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (this.root.classList.contains('collapsed')) return;
      this.cleanupResizerDrag?.();
      startX = e.clientX;
      startWidth = this.root.getBoundingClientRect().width;
      this.root.classList.add('resizing');
      resizing = true;
      this.onResizeStart();
      document.body.style.cursor = 'col-resize';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      this.cleanupResizerDrag = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        this.root?.classList.remove('resizing');
        if (resizing) {
          commitWidth();
          resizing = false;
          this.onResizeEnd();
        }
      };
    });
    this.resizer.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? 16 : -16;
      const width = clampSidebarWidth((parseInt(this.root.style.width, 10) || DEFAULT_SIDEBAR_WIDTH) + delta);
      this.root.style.width = width + 'px';
      if (this.inner) this.inner.style.width = width + 'px';
      saveSidebarWidth(this.tab, width);
      this.onLayoutChange();
    });
  }

  async loadForTarget(targetID) {
    const startedAt = performance.now();
    perfLog('loadForTarget start', { tab: this.tab.id, targetID, open: this.isOpen() });
    try {
      this.chatsForTarget = (await listAIChatSessionsForTarget(targetID)) || [];
    } catch (e) {
      console.error('listAIChatSessionsForTarget:', e);
      this.chatsForTarget = [];
    }
    perfLog('loadForTarget fetched sessions', {
      tab: this.tab.id,
      count: this.chatsForTarget.length,
      elapsed: (performance.now() - startedAt).toFixed(1) + 'ms',
    });
    if (!this.active || this.currentTargetID !== targetID) return;
    if (!this.isOpen()) return;
    await this.ensureOpenContent();
    perfLog('loadForTarget done', this.tab.id, (performance.now() - startedAt).toFixed(1) + 'ms');
  }

  async ensureOpenContent() {
    const startedAt = performance.now();
    perfLog('ensureOpenContent start', {
      tab: this.tab.id,
      currentTargetID: this.currentTargetID,
      open: this.isOpen(),
      chats: this.chatsForTarget.length,
      currentChatID: this.currentChatID,
    });
    if (!this.active || !this.currentTargetID || !this.isOpen() || !aiEnabled) return;
    if (this.chatsForTarget.length > 0) {
      await this.openChat(this.currentChatID || this.chatsForTarget[0].id);
    } else {
      await this.showSessionList();
    }
    perfLog('ensureOpenContent done', this.tab.id, (performance.now() - startedAt).toFixed(1) + 'ms');
  }

  async refreshSessionsForTarget(targetID) {
    try {
      const chats = (await listAIChatSessionsForTarget(targetID)) || [];
      if (!this.active || this.destroyed || this.currentTargetID !== targetID) return;
      this.chatsForTarget = chats;
      if (!this.isOpen()) return;
      if (this.currentChatID && !this.chatsForTarget.some(sess => sess.id === this.currentChatID)) {
        this.leaveChat();
        await this.ensureOpenContent();
      } else if (this.listEl && this.listEl.style.display !== 'none') {
        this.renderSessionList();
      }
    } catch (e) {
      console.error('listAIChatSessionsForTarget:', e);
    }
  }

  showSessionList() {
    this.leaveChat();
    this.confirmingDeleteID = null;
    if (this.chatEl) this.chatEl.style.display = 'none';
    if (this.listEl) this.listEl.style.display = '';
    if (this.backBtn) this.backBtn.style.display = 'none';
    this.updateHeader();
    return this.renderSessionList();
  }

  async renderSessionList() {
    if (!this.listEl || !this.currentTargetID) return;
    this.listEl.innerHTML = '';

    try {
      this.chatsForTarget = (await listAIChatSessionsForTarget(this.currentTargetID)) || [];
    } catch (e) {
      console.error('listAIChatSessionsForTarget:', e);
      showToast('❌ ' + e);
      this.chatsForTarget = [];
    }

    if (this.chatsForTarget.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-empty';
      empty.textContent = t('aiSidebar.noChats');
      this.listEl.appendChild(empty);
      return;
    }
    const results = document.createElement('div');
    results.className = 'ai-session-results';
    const renderMatches = (query = '') => {
      const normalized = query.trim().toLocaleLowerCase();
      results.replaceChildren(...this.chatsForTarget
        .filter(sess => !normalized || (sess.title || '').toLocaleLowerCase().includes(normalized))
        .map(sess => this.renderSessionItem(sess)));
      if (!results.children.length) {
        const empty = document.createElement('div');
        empty.className = 'ai-empty';
        empty.textContent = t('aiSidebar.noMatchingChats');
        results.appendChild(empty);
      }
    };
    if (this.chatsForTarget.length > 8) {
      const search = document.createElement('input');
      search.className = 'input ai-session-search';
      search.type = 'search';
      search.placeholder = t('aiSidebar.searchChats');
      search.setAttribute('aria-label', t('aiSidebar.searchChats'));
      search.addEventListener('input', () => renderMatches(search.value));
      this.listEl.appendChild(search);
    }
    this.listEl.appendChild(results);
    renderMatches();
  }

  renderSessionItem(sess) {
    const item = document.createElement('div');
    item.className = 'ai-session-item';
    item.dataset.id = sess.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const confirming = this.confirmingDeleteID === sess.id;
    item.innerHTML = `
      <div class="ai-session-item-info">
        <div class="ai-session-item-title">${escHtml(sess.title || t('aiSidebar.defaultChatTitle'))}</div>
        <div class="ai-session-item-sub">${escHtml(formatRelativeTime(sess.updated_at))}</div>
      </div>
      <div class="ai-session-item-actions${confirming ? ' confirming' : ''}">
        ${confirming ? `
          <span class="ai-confirm-label">${t('aiSidebar.confirmDeleteShort')}</span>
          <button class="btn btn-danger btn-sm" data-action="confirm-delete" type="button">${t('common.delete')}</button>
          <button class="btn btn-ghost btn-sm" data-action="cancel-delete" type="button">${t('common.cancel')}</button>
        ` : `
          <button class="btn btn-ghost btn-icon btn-sm" data-action="rename" title="${t('common.rename')}" type="button">✏️</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-action="delete" title="${t('common.delete')}" type="button">🗑</button>
        `}
      </div>`;

    item.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'rename') { this.startRename(sess, item); return; }
      if (action === 'delete') { this.confirmingDeleteID = sess.id; this.renderSessionList(); return; }
      if (action === 'confirm-delete') { this.confirmingDeleteID = null; this.handleDelete(sess); return; }
      if (action === 'cancel-delete') { this.confirmingDeleteID = null; this.renderSessionList(); return; }
      if (confirming) return;
      this.openChat(sess.id);
    });
    item.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === item && !confirming) {
        e.preventDefault();
        this.openChat(sess.id);
      }
    });
    return item;
  }

  startRename(sess, item) {
    const titleEl = item.querySelector('.ai-session-item-title');
    if (!titleEl) return;
    const input = document.createElement('input');
    input.className = 'input ai-session-rename-input';
    input.value = sess.title || '';
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    input.addEventListener('click', (e) => e.stopPropagation());

    let settled = false;
    const commit = async () => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      if (next && next !== sess.title) {
        try { await renameAIChatSession(sess.id, next); } catch (e) { showToast('❌ ' + e); }
      }
      this.renderSessionList();
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      this.renderSessionList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  }

  async handleDelete(sess) {
    try {
      await deleteAIChatSession(sess.id);
    } catch (e) {
      showToast('❌ ' + e);
      return;
    }
    if (this.currentChatID === sess.id) {
      this.leaveChat();
      this.showSessionList();
    } else {
      this.renderSessionList();
    }
  }

  async handleNewChat() {
    if (!this.currentTargetID) return;
    try {
      const sess = await createAIChatSession(this.currentTargetID, t('aiSidebar.defaultChatTitle'));
      this.chatsForTarget = [sess, ...this.chatsForTarget];
      await this.openChat(sess.id);
    } catch (e) {
      showToast('❌ ' + e);
    }
  }

  async openChat(chatID) {
    const startedAt = performance.now();
    const sameChat = this.currentChatID === chatID;
    perfLog('openChat start', {
      tab: this.tab.id,
      chatID,
      sameChat,
      hasMessagesEl: !!this.messagesEl,
      renderedSignature: this.lastRenderedSignature,
    });
    if (this.currentChatID && !sameChat) this.unsubscribeChatEvents();
    this.currentChatID = chatID;
    this.currentAssistantBubble = null;
    if (!sameChat) this.cardsByToolCallID = {};

    const sess = this.chatsForTarget.find(s => s.id === chatID);
    this.currentAutoExec = !!sess?.auto_exec;

    if (this.listEl) this.listEl.style.display = 'none';
    if (this.backBtn) this.backBtn.style.display = '';
    this.updateHeader();
    if (this.chatEl) {
      this.chatEl.style.display = '';
      if (!sameChat || !this.messagesEl) this.buildChatViewSkeleton(this.chatEl);
    }

    if (this.active) this.subscribeChatEvents(chatID);
    this.setSending(false);
    if (!sameChat || !this.messagesEl) this.lastRenderedSignature = null;
    perfLog('openChat before refresh', this.tab.id, (performance.now() - startedAt).toFixed(1) + 'ms');
    await this.refreshCurrentChat(chatID);
    if (this.active && this.currentChatID === chatID) {
      try { this.setSending(await isAIRunActive(chatID)); } catch { /* keep idle state */ }
    }
    perfLog('openChat done', this.tab.id, (performance.now() - startedAt).toFixed(1) + 'ms');
  }

  // Re-fetches chatID's messages and re-renders only if they actually
  // changed since the last render. Skipping the no-op case matters because
  // this runs on every single tab (re)activation, and re-rendering a long
  // chat history just to scroll it back to an unchanged bottom forces an
  // expensive layout — see the tab-switch performance investigation.
  async refreshCurrentChat(chatID = this.currentChatID) {
    if (!chatID || !this.chatEl) return;
    const startedAt = performance.now();
    if (!this.isOpen() && !this.isSending) {
      perfLog('refreshCurrentChat skip closed', { tab: this.tab.id, chatID });
      return;
    }
    perfLog('refreshCurrentChat start', { tab: this.tab.id, chatID });
    try {
      const messages = (await getAIChatMessages(chatID)) || [];
      perfLog('refreshCurrentChat fetched', {
        tab: this.tab.id,
        chatID,
        messages: messages.length,
        elapsed: (performance.now() - startedAt).toFixed(1) + 'ms',
      });
      if (this.destroyed || this.currentChatID !== chatID) return;
      const signature = messages.length + ':' + (messages.at(-1)?.id ?? '');
      if (signature === this.lastRenderedSignature) {
        perfLog('refreshCurrentChat skip unchanged', {
          tab: this.tab.id,
          signature,
          elapsed: (performance.now() - startedAt).toFixed(1) + 'ms',
        });
        return;
      }
      this.lastRenderedSignature = signature;
      this.renderHistory(messages);
      perfLog('refreshCurrentChat rendered', {
        tab: this.tab.id,
        signature,
        elapsed: (performance.now() - startedAt).toFixed(1) + 'ms',
      });
    } catch (e) {
      if (this.destroyed || this.currentChatID !== chatID) return;
      console.error('getAIChatMessages:', e);
      showToast('❌ ' + e);
    }
  }

  leaveChat() {
    this.unsubscribeChatEvents();
    this.currentChatID = null;
    this.currentAssistantBubble = null;
    this.cardsByToolCallID = {};
    this.pendingContexts = [];
    this.updateHeader();
  }

  buildChatViewSkeleton(chatView) {
    chatView.innerHTML = '';

    const messages = document.createElement('div');
    messages.className = 'ai-chat-messages';
    messages.addEventListener('scroll', () => {
      this.userNearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 72;
      this.latestBtn?.classList.toggle('visible', !this.userNearBottom);
    });

    const latestBtn = document.createElement('button');
    latestBtn.className = 'btn btn-secondary btn-sm ai-latest-btn';
    latestBtn.textContent = t('aiSidebar.backToLatest');
    latestBtn.addEventListener('click', () => {
      this.userNearBottom = true;
      messages.scrollTop = messages.scrollHeight;
      latestBtn.classList.remove('visible');
    });

    const composer = document.createElement('div');
    composer.className = 'ai-composer';
    const contextRow = document.createElement('div');
    contextRow.className = 'ai-context-row';
    const contextChips = document.createElement('div');
    contextChips.className = 'ai-context-chips';
    const contextMenu = document.createElement('details');
    contextMenu.className = 'ai-context-menu';
    contextMenu.innerHTML = `<summary aria-label="${t('aiSidebar.addContext')}">＋ ${t('aiSidebar.context')}</summary>`;
    const menuBody = document.createElement('div');
    menuBody.className = 'ai-context-menu-body';
    const selectionBtn = document.createElement('button');
    selectionBtn.type = 'button';
    selectionBtn.textContent = t('aiSidebar.attachSelection');
    selectionBtn.addEventListener('click', () => {
      this.addContext('terminal_selection', t('aiSidebar.selectedTerminalText'), this.getTerminalSelection());
      contextMenu.open = false;
    });
    const outputBtn = document.createElement('button');
    outputBtn.type = 'button';
    outputBtn.textContent = t('aiSidebar.attachRecentOutput');
    outputBtn.addEventListener('click', () => {
      this.addContext('terminal_output', t('aiSidebar.recentTerminalOutput'), this.getTerminalRecentOutput());
      contextMenu.open = false;
    });
    menuBody.append(selectionBtn, outputBtn);
    contextMenu.appendChild(menuBody);
    contextRow.append(contextMenu, contextChips);

    const inputRow = document.createElement('div');
    inputRow.className = 'ai-chat-input-row';
    const textarea = document.createElement('textarea');
    textarea.rows = 1;
    textarea.placeholder = t('aiSidebar.inputPlaceholder');
    textarea.value = sessionStorage.getItem(this.draftKey()) || '';
    let composing = false;
    let compositionJustEndedUntil = 0;
    textarea.addEventListener('compositionstart', () => { composing = true; });
    textarea.addEventListener('compositionend', () => {
      composing = false;
      compositionJustEndedUntil = Date.now() + 80;
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (e.isComposing || composing || e.keyCode === 229 || Date.now() < compositionJustEndedUntil) return;
        e.preventDefault();
        this.handleSend();
      }
    });
    textarea.addEventListener('input', () => {
      this.resizeInput();
      sessionStorage.setItem(this.draftKey(), textarea.value);
    });
    const actionBtn = document.createElement('button');
    actionBtn.className = 'btn btn-primary btn-icon ai-chat-action';
    actionBtn.setAttribute('aria-label', t('aiSidebar.send'));
    actionBtn.textContent = '↑';
    actionBtn.addEventListener('click', async () => {
      if (!this.isSending) return this.handleSend();
      try {
        this.stopRequested = true;
        this.setRunStatus(t('aiSidebar.stopping'));
        await stopAIRun(this.currentChatID);
      } catch (e) { showToast('❌ ' + e); }
    });
    inputRow.append(textarea, actionBtn);

    const footer = document.createElement('div');
    footer.className = 'ai-composer-footer';
    const status = document.createElement('span');
    status.className = 'ai-run-status';
    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.className = 'ai-exec-toggle';
    modeBtn.setAttribute('role', 'switch');
    const modeLabel = document.createElement('span');
    modeLabel.className = 'ai-exec-toggle-label';
    modeLabel.textContent = t('aiSidebar.autoExecLabel');
    const modeHelp = document.createElement('span');
    modeHelp.className = 'ai-exec-toggle-help';
    modeHelp.textContent = '?';
    modeHelp.setAttribute('aria-hidden', 'true');
    const modeTrack = document.createElement('span');
    modeTrack.className = 'ai-exec-toggle-track';
    modeTrack.setAttribute('aria-hidden', 'true');
    modeBtn.append(modeLabel, modeHelp, modeTrack);
    modeBtn.addEventListener('click', () => this.toggleAutoExec(modeBtn));
    footer.append(status, modeBtn);
    composer.append(contextRow, inputRow, footer);

    this.messagesEl = messages;
    this.inputEl = textarea;
    this.actionBtn = actionBtn;
    this.statusEl = status;
    this.modeBtn = modeBtn;
    this.contextChipsEl = contextChips;
    this.latestBtn = latestBtn;
    this.updateExecMode();
    this.renderPendingContexts();
    requestAnimationFrame(() => this.resizeInput());

    chatView.append(messages, latestBtn, composer);
  }

  draftKey() {
    return 'ai-draft-' + (this.currentChatID || 'new');
  }

  resizeInput() {
    if (!this.inputEl) return;
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 132) + 'px';
  }

  setRunStatus(text = '') {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  addContext(kind, label, content) {
    content = String(content || '').trim();
    if (!content) {
      showToast(t('aiSidebar.noContextAvailable'));
      return;
    }
    const maxBytes = 64 * 1024;
    let truncated = false;
    if (new TextEncoder().encode(content).length > maxBytes) {
      content = content.slice(0, maxBytes);
      truncated = true;
    }
    this.pendingContexts.push({ kind, label, content, truncated });
    this.renderPendingContexts();
  }

  renderPendingContexts() {
    if (!this.contextChipsEl) return;
    this.contextChipsEl.replaceChildren(...this.pendingContexts.map((item, index) => {
      const chip = document.createElement('span');
      chip.className = 'ai-context-chip';
      chip.title = item.label + (item.truncated ? ' · ' + t('aiSidebar.truncated') : '');
      const label = document.createElement('span');
      label.textContent = item.label + (item.truncated ? '…' : '');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', t('aiSidebar.removeContext', { label: item.label }));
      remove.addEventListener('click', () => {
        this.pendingContexts.splice(index, 1);
        this.renderPendingContexts();
      });
      chip.append(label, remove);
      return chip;
    }));
  }

  async toggleAutoExec(button) {
    const next = !this.currentAutoExec;
    if (next) {
      const confirmed = await confirmDialog(t('aiSidebar.autoExecWarning'), {
        okLabel: t('aiSidebar.enableAutoExec'),
        cancelLabel: t('common.cancel'),
        danger: true,
      });
      if (!confirmed) return;
    }

    button.disabled = true;
    try {
      await setAIAutoExec(this.currentChatID, next);
      this.currentAutoExec = next;
    } catch (e) {
      showToast('❌ ' + e);
    } finally {
      button.disabled = false;
      this.updateExecMode();
    }
  }

  updateExecMode() {
    if (!this.modeBtn) return;
    const state = this.currentAutoExec ? t('aiSidebar.autoExecOn') : t('aiSidebar.askBeforeRun');
    this.modeBtn.classList.toggle('on', this.currentAutoExec);
    this.modeBtn.setAttribute('aria-checked', String(this.currentAutoExec));
    this.modeBtn.setAttribute('aria-label', t('aiSidebar.autoExecLabel') + ': ' + state);
    this.modeBtn.title = t('aiSidebar.autoExecDesc') +
      (this.currentAutoExec ? '\n' + t('aiSidebar.autoExecWarning') : '');
  }

  async confirmContextAutoExec(contexts) {
    if (!this.currentAutoExec || !contexts.length) return true;
    if (this.isConfirmingSend) return false;
    this.isConfirmingSend = true;
    try {
      return await confirmDialog(t('aiSidebar.contextAutoExecWarning'), {
        okLabel: t('aiSidebar.sendAnyway'),
        cancelLabel: t('common.cancel'),
        danger: true,
      });
    } finally {
      this.isConfirmingSend = false;
    }
  }

  async handleSend() {
    if (!this.inputEl || this.isSending || this.isConfirmingSend || !this.currentChatID) return;
    const chatID = this.currentChatID;
    const text = this.inputEl.value.trim();
    if (!text) return;
    const contexts = this.pendingContexts.map(item => ({ ...item }));
    if (!await this.confirmContextAutoExec(contexts) || this.currentChatID !== chatID) return;

    this.messagesEl?.querySelectorAll('.ai-msg.error.retryable').forEach(el => el.remove());
    this.lastFailedPrompt = { text, contexts };
    this.inputEl.value = '';
    sessionStorage.removeItem(this.draftKey());
    this.resizeInput();
    this.pendingContexts = [];
    this.renderPendingContexts();
    this.appendUserBubble(text, contexts);
    await this.sendUnpersistedPrompt(chatID, text, contexts);
  }

  async sendUnpersistedPrompt(chatID, text, contexts) {
    this.setSending(true);
    try {
      await sendAIMessage(chatID, this.getConnID() || '', text, contexts);
    } catch (e) {
      this.appendErrorBubble(String(e), () => this.retryUnpersistedPrompt(chatID, text, contexts));
      this.setSending(false);
    }
  }

  async retryUnpersistedPrompt(chatID, text, contexts) {
    if (this.currentChatID !== chatID || !await this.confirmContextAutoExec(contexts)) return false;
    await this.sendUnpersistedPrompt(chatID, text, contexts);
    return true;
  }

  async retryPersistedTurn(contexts) {
    const chatID = this.currentChatID;
    if (!chatID || !await this.confirmContextAutoExec(contexts)) return false;
    this.setSending(true);
    try {
      await retryAIMessage(chatID, this.getConnID() || '');
    } catch (e) {
      this.appendErrorBubble(String(e), () => this.retryPersistedTurn(contexts));
      this.setSending(false);
    }
    return true;
  }

  setSending(sending) {
    this.isSending = sending;
    if (this.actionBtn) {
      this.actionBtn.textContent = sending ? '■' : '↑';
      this.actionBtn.classList.toggle('running', sending);
      this.actionBtn.setAttribute('aria-label', t(sending ? 'aiSidebar.stop' : 'aiSidebar.send'));
    }
    this.setRunStatus(sending ? t('aiSidebar.thinking') : '');
  }

  subscribeChatEvents(chatID) {
    this.unsubscribeChatEvents();
    this.addEvent('ai:title:' + chatID, payload => this.handleTitle(payload));
    this.addEvent('ai:delta:' + chatID, payload => this.handleDelta(payload));
    this.addEvent('ai:tool_call:' + chatID, payload => this.handleToolCall(payload));
    this.addEvent('ai:tool_result:' + chatID, payload => this.handleToolResult(payload));
    this.addEvent('ai:tool_rejected:' + chatID, payload => this.handleToolRejected(payload));
    this.addEvent('ai:done:' + chatID, payload => this.handleDone(payload));
    this.addEvent('ai:error:' + chatID, payload => this.handleError(payload));
  }

  addEvent(event, handler) {
    const cancel = on(event, handler);
    this.unsubscribers.push(() => {
      if (typeof cancel === 'function') cancel();
      else off(event);
    });
  }

  unsubscribeChatEvents() {
    this.unsubscribers.splice(0).forEach(cancel => cancel());
  }

  handleTitle({ chat_id: chatID, title }) {
    const sess = this.chatsForTarget.find(item => item.id === chatID);
    if (sess && title) sess.title = title;
    if (chatID === this.currentChatID) this.updateHeader();
  }

  handleDelta({ content }) {
    this.appendAssistantDelta(content);
  }

  handleToolCall(payload) {
    this.setRunStatus(t('aiSidebar.awaitingApproval'));
    this.renderPendingToolCard(payload);
  }

  handleToolResult(payload) {
    this.setRunStatus(t('aiSidebar.processingResult'));
    this.applyToolResult(payload);
  }

  handleToolRejected(payload) {
    this.applyToolRejected(payload);
  }

  handleDone() {
    if (this.markdownFrame) {
      cancelAnimationFrame(this.markdownFrame);
      this.markdownFrame = 0;
    }
    if (this.currentAssistantBubble) {
      this.currentAssistantBubble.innerHTML = renderMarkdown(this.currentAssistantRaw);
      addMessageActions(this.currentAssistantBubble);
    }
    this.currentAssistantBubble = null;
    this.stopRequested = false;
    this.lastFailedPrompt = null;
    this.setSending(false);
  }

  handleError({ message }) {
    this.currentAssistantBubble = null;
    if (this.stopRequested) {
      this.appendStatusMessage(t('aiSidebar.stopped'));
      this.stopRequested = false;
    } else {
      const contexts = this.lastFailedPrompt?.contexts || [];
      this.appendErrorBubble(t('aiSidebar.chatError', { e: message }), () => this.retryPersistedTurn(contexts));
    }
    this.setSending(false);
  }

  scrollToBottom(force = false) {
    if (!this.messagesEl) return;
    if (!this.active || !this.isTerminalActive() || !this.isOpen()) return;
    if (!force && !this.userNearBottom) {
      this.latestBtn?.classList.add('visible');
      return;
    }
    const startedAt = performance.now();
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    perfLog('scrollToBottom', {
      tab: this.tab.id,
      cost: (performance.now() - startedAt).toFixed(1) + 'ms',
      scrollHeight: this.messagesEl.scrollHeight,
      nodes: this.messagesEl.children.length,
    });
  }

  appendUserBubble(text, contexts = []) {
    this.messagesEl?.querySelector('.ai-chat-empty')?.remove();
    const el = document.createElement('div');
    el.className = 'ai-msg user';
    el.appendChild(messageContextSummary(contexts));
    const body = document.createElement('div');
    body.textContent = text;
    el.appendChild(body);
    this.messagesEl?.appendChild(el);
    this.userNearBottom = true;
    this.scrollToBottom(true);
  }

  appendErrorBubble(text, onRetry = null) {
    const el = document.createElement('div');
    el.className = 'ai-msg error' + (onRetry ? ' retryable' : '');
    const body = document.createElement('span');
    body.textContent = text;
    el.appendChild(body);
    if (onRetry) {
      const retry = document.createElement('button');
      retry.className = 'btn btn-ghost btn-sm';
      retry.textContent = t('aiSidebar.retry');
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        const handled = await onRetry();
        if (handled) el.remove();
        else retry.disabled = false;
      });
      el.appendChild(retry);
    }
    this.messagesEl?.appendChild(el);
    this.scrollToBottom();
  }

  appendStatusMessage(text) {
    const el = document.createElement('div');
    el.className = 'ai-run-note';
    el.textContent = text;
    this.messagesEl?.appendChild(el);
    this.scrollToBottom();
  }

  appendAssistantDelta(content) {
    if (!this.currentAssistantBubble) {
      this.currentAssistantBubble = document.createElement('div');
      this.currentAssistantBubble.className = 'ai-msg assistant';
      this.messagesEl?.appendChild(this.currentAssistantBubble);
      this.currentAssistantRaw = '';
    }
    this.currentAssistantRaw += content;
    this.setRunStatus(t('aiSidebar.responding'));
    if (!this.markdownFrame) {
      this.markdownFrame = requestAnimationFrame(() => {
        this.markdownFrame = 0;
        if (!this.currentAssistantBubble) return;
        this.currentAssistantBubble.innerHTML = renderMarkdown(this.currentAssistantRaw);
        this.scrollToBottom();
      });
    }
  }

  renderPendingToolCard({ pending_id, tool_call_id, command }) {
    this.currentAssistantBubble = null;
    const card = document.createElement('div');
    card.className = 'ai-tool-card pending';
    card.dataset.startedAt = String(Date.now());

    const cmdEl = document.createElement('div');
    cmdEl.className = 'ai-tool-card-command';
    cmdEl.textContent = '$ ' + command;

    const actions = document.createElement('div');
    actions.className = 'ai-tool-card-actions';
    const runBtn = document.createElement('button');
    runBtn.className = 'btn btn-primary btn-sm';
    runBtn.textContent = t('aiSidebar.runButton');
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-danger btn-sm';
    rejectBtn.textContent = t('aiSidebar.rejectButton');

    const status = document.createElement('div');
    status.className = 'ai-tool-card-status';
    status.textContent = t('aiSidebar.proposedCommand');

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      rejectBtn.disabled = true;
      status.textContent = t('aiSidebar.running');
      try { await approveAIToolCall(pending_id); } catch (e) { status.textContent = String(e); }
    });
    rejectBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      rejectBtn.disabled = true;
      try { await rejectAIToolCall(pending_id); } catch (e) { status.textContent = String(e); }
    });
    actions.append(runBtn, rejectBtn);

    card.append(cmdEl, actions, status);
    this.messagesEl?.appendChild(card);
    this.scrollToBottom();
    this.cardsByToolCallID[tool_call_id] = card;
  }

  applyToolResult({ tool_call_id, tool, command, output }) {
    this.currentAssistantBubble = null;
    const card = this.cardOrPlaceholder(tool_call_id, tool, command);
    card.className = 'ai-tool-card done';
    card.querySelector('.ai-tool-card-actions')?.remove();
    card.querySelector('.ai-tool-card-status')?.remove();
    const startedAt = Number(card.dataset.startedAt);
    const status = document.createElement('div');
    status.className = 'ai-tool-card-status';
    status.textContent = startedAt
      ? t('aiSidebar.completedIn', { duration: formatDuration(Date.now() - startedAt) })
      : t('common.done');
    card.appendChild(status);
    appendToolOutput(card, output || t('aiSidebar.noOutput'));
    this.scrollToBottom();
  }

  applyToolRejected({ tool_call_id }) {
    this.currentAssistantBubble = null;
    const card = this.cardsByToolCallID[tool_call_id];
    if (!card) return;
    card.className = 'ai-tool-card rejected';
    card.querySelector('.ai-tool-card-actions')?.remove();
    let status = card.querySelector('.ai-tool-card-status');
    if (!status) {
      status = document.createElement('div');
      status.className = 'ai-tool-card-status';
      card.appendChild(status);
    }
    status.textContent = t('aiSidebar.rejected');
    this.scrollToBottom();
  }

  cardOrPlaceholder(toolCallID, tool, command) {
    let card = this.cardsByToolCallID[toolCallID];
    if (card) return card;
    card = document.createElement('div');
    card.className = 'ai-tool-card';
    const cmdEl = document.createElement('div');
    cmdEl.className = 'ai-tool-card-command';
    cmdEl.textContent = toolLabel(tool, command);
    card.appendChild(cmdEl);
    this.messagesEl?.appendChild(card);
    this.cardsByToolCallID[toolCallID] = card;
    return card;
  }

  renderHistory(messages) {
    if (!this.messagesEl) return;
    const startedAt = performance.now();
    perfLog('renderHistory start', { tab: this.tab.id, messages: messages.length });
    this.cardsByToolCallID = {};
    this.currentAssistantBubble = null;
    const fragment = document.createDocumentFragment();

    const toolResultsByID = {};
    messages.forEach(m => {
      if (m.role === 'tool' && m.tool_call_id) toolResultsByID[m.tool_call_id] = m;
    });

    messages.forEach(m => {
      if (m.role === 'user') {
        const el = document.createElement('div');
        el.className = 'ai-msg user';
        let contexts = [];
        try { contexts = JSON.parse(m.context_json || '[]'); } catch { contexts = []; }
        el.appendChild(messageContextSummary(contexts));
        const body = document.createElement('div');
        body.textContent = m.content;
        el.appendChild(body);
        fragment.appendChild(el);
      } else if (m.role === 'assistant') {
        if (m.content) {
          const el = document.createElement('div');
          el.className = 'ai-msg assistant';
          el.innerHTML = renderMarkdown(m.content);
          fragment.appendChild(el);
        }
        if (m.tool_calls) {
          let calls = [];
          try { calls = JSON.parse(m.tool_calls); } catch { calls = []; }
          calls.forEach(call => this.renderHistoricalToolCall(call, toolResultsByID[call.id], fragment));
        }
      }
    });
    perfLog('renderHistory built fragment', {
      tab: this.tab.id,
      messages: messages.length,
      fragmentNodes: fragment.childNodes.length,
      elapsed: (performance.now() - startedAt).toFixed(1) + 'ms',
    });
    const replaceStartedAt = performance.now();
    this.messagesEl.replaceChildren(fragment);
    if (!this.messagesEl.children.length) this.renderEmptyState();
    this.messagesEl.querySelectorAll('.ai-msg.assistant').forEach(el => addMessageActions(el));
    perfLog('renderHistory replaceChildren', {
      tab: this.tab.id,
      cost: (performance.now() - replaceStartedAt).toFixed(1) + 'ms',
      nodes: this.messagesEl.children.length,
    });
    this.scrollToBottom();
    perfLog('renderHistory done', this.tab.id, (performance.now() - startedAt).toFixed(1) + 'ms');
  }

  renderHistoricalToolCall(call, resultMsg, parent = this.messagesEl) {
    if (!this.messagesEl) return;
    let args = {};
    try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
    let command;
    if (call.function?.name === 'open_url') command = args.url || '';
    else if (call.function?.name === 'terminal_run') command = args.command || '';
    else command = Object.values(args).map(String).join(' ');
    const rejected = resultMsg?.content === 'User declined to run this command.';

    const card = document.createElement('div');
    card.className = 'ai-tool-card ' + (rejected ? 'rejected' : 'done');

    const cmdEl = document.createElement('div');
    cmdEl.className = 'ai-tool-card-command';
    cmdEl.textContent = toolLabel(call.function?.name, command);
    card.appendChild(cmdEl);

    if (rejected) {
      const status = document.createElement('div');
      status.className = 'ai-tool-card-status';
      status.textContent = t('aiSidebar.rejected');
      card.appendChild(status);
    } else if (resultMsg) {
      const status = document.createElement('div');
      status.className = 'ai-tool-card-status';
      status.textContent = t('common.done');
      card.appendChild(status);
      appendToolOutput(card, resultMsg.content || t('aiSidebar.noOutput'));
    }

    parent.appendChild(card);
    if (call.id) this.cardsByToolCallID[call.id] = card;
  }

  renderEmptyState() {
    if (!this.messagesEl) return;
    const empty = document.createElement('div');
    empty.className = 'ai-chat-empty';
    const title = document.createElement('strong');
    title.textContent = t('aiSidebar.emptyTitle');
    const hint = document.createElement('span');
    hint.textContent = t('aiSidebar.emptyHint');
    const prompts = document.createElement('div');
    prompts.className = 'ai-starter-prompts';
    [t('aiSidebar.promptExplainError'), t('aiSidebar.promptSummarizeOutput'), t('aiSidebar.promptGenerateCommand')]
      .forEach(text => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.addEventListener('click', () => {
          this.inputEl.value = text;
          this.resizeInput();
          this.inputEl.focus();
        });
        prompts.appendChild(button);
      });
    empty.append(title, hint, prompts);
    this.messagesEl.appendChild(empty);
  }
}

function addMessageActions(container) {
  const responseText = container.innerText;
  addCopyButtons(container);
  if (container.querySelector(':scope > .ai-message-actions')) return;
  const actions = document.createElement('div');
  actions.className = 'ai-message-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = t('aiSidebar.copyResponse');
  copy.addEventListener('click', () => copyText(copy, responseText));
  actions.appendChild(copy);
  container.appendChild(actions);
}

function addCopyButtons(container) {
  container.querySelectorAll('pre:not([data-has-header])').forEach(pre => {
    pre.setAttribute('data-has-header', '1');
    const code = pre.querySelector('code');
    const langClass = code?.className?.match(/language-(\S+)/)?.[1] || '';
    const lang = langClass === 'plaintext' ? '' : langClass;

    const wrapper = document.createElement('div');
    wrapper.className = 'ai-code-block';

    const header = document.createElement('div');
    header.className = 'ai-code-block-header';

    const langLabel = document.createElement('span');
    langLabel.textContent = lang;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'ai-code-copy-btn';
    copyBtn.textContent = t('aiSidebar.copyCode');
    copyBtn.addEventListener('click', () => {
      const text = code ? code.textContent : pre.textContent;
      copyText(copyBtn, text);
    });

    header.append(langLabel, copyBtn);
    pre.replaceWith(wrapper);
    wrapper.append(header, pre);
  });
}

function copyText(button, text) {
  const original = button.textContent;
  navigator.clipboard.writeText(text).then(() => {
    button.textContent = t('aiSidebar.copied');
    setTimeout(() => { button.textContent = original; }, 1500);
  }).catch(() => showToast(t('aiSidebar.copyFailed')));
}

function messageContextSummary(contexts = []) {
  const fragment = document.createDocumentFragment();
  if (!contexts.length) return fragment;
  const row = document.createElement('div');
  row.className = 'ai-message-contexts';
  contexts.forEach(item => {
    const chip = document.createElement('span');
    chip.textContent = item.label || item.kind;
    chip.title = item.truncated ? t('aiSidebar.truncated') : (item.label || item.kind);
    row.appendChild(chip);
  });
  fragment.appendChild(row);
  return fragment;
}

function appendToolOutput(card, output) {
  const details = document.createElement('details');
  details.className = 'ai-tool-card-details';
  const longOutput = output.length > 600 || output.split('\n').length > 12;
  details.open = !longOutput;
  const summary = document.createElement('summary');
  summary.textContent = longOutput ? t('aiSidebar.showOutput') : t('aiSidebar.output');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'ai-tool-copy';
  copy.textContent = t('aiSidebar.copyOutput');
  copy.addEventListener('click', e => {
    e.preventDefault();
    copyText(copy, output);
  });
  const outEl = document.createElement('div');
  outEl.className = 'ai-tool-card-output';
  outEl.textContent = output;
  details.append(summary, copy, outEl);
  card.appendChild(details);
}

function formatDuration(ms) {
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function toolLabel(tool, command) {
  if (tool === 'terminal_read') return t('aiSidebar.readAction');
  if (tool === 'open_url') return t('aiSidebar.openURLAction', { url: command || '' });
  return '$ ' + command;
}
