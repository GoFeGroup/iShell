import {
  listAIChatSessionsForTarget, createAIChatSession, renameAIChatSession, deleteAIChatSession,
  getAIChatMessages, sendAIMessage, approveAIToolCall, rejectAIToolCall, setAIAutoExec,
  stopAIRun, isAIRunActive, on, off,
} from './api.js';
import { t } from './i18n.js';
import { showToast } from './toast.js';
import { renderMarkdown } from './markdown.js';

let getActiveTab = () => null;
let aiEnabled = false;
let activeInstance = null;
const PERF_DEBUG = true;

function perfLog(label, ...args) {
  if (PERF_DEBUG) console.log('[PERF-AI]', label, ...args);
}

const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 640;
const DEFAULT_SIDEBAR_WIDTH = 320;

export function initAISidebar(settings, activeTabGetter) {
  getActiveTab = activeTabGetter;
  setAISidebarSettings(settings);
  document.getElementById('btn-toggle-ai')?.addEventListener('click', toggleAISidebar);
}

export function setAISidebarSettings(settings) {
  aiEnabled = !!settings?.ai_enabled;
  if (!aiEnabled) activeInstance?.setOpen(false, { animate: true, notify: true });
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

function savedSidebarWidth(tab) {
  const key = tab?.id ? 'ai-sidebar-width-' + tab.id : 'ai-sidebar-width';
  try {
    const perTab = parseInt(localStorage.getItem(key), 10);
    if (perTab >= MIN_SIDEBAR_WIDTH && perTab <= MAX_SIDEBAR_WIDTH) return perTab;
    const saved = parseInt(localStorage.getItem('ai-sidebar-width'), 10);
    if (saved >= MIN_SIDEBAR_WIDTH && saved <= MAX_SIDEBAR_WIDTH) return saved;
  } catch { /* ignore */ }
  return DEFAULT_SIDEBAR_WIDTH;
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
    this.closeBtn = els.closeBtn;
    this.getConnID = options.getConnID || (() => '');
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
    this.cardsByToolCallID = {};
    this.confirmingDeleteID = null;
    this.unsubscribers = [];
    this.cleanupResizerDrag = null;
    this.pendingInnerHideListener = null;
    this.pendingInnerShowRAFs = [];
    this.destroyed = false;
    this.active = false;

    this.backBtn?.addEventListener('click', () => this.showSessionList());
    this.closeBtn?.addEventListener('click', () => this.setOpen(false, { animate: true, notify: true }));
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
    this.cancelPendingInnerShow();
    this.cleanupResizerDrag?.();
    this.cleanupResizerDrag = null;
  }

  syncTarget() {
    if (!this.active || !this.isTerminalActive() || !aiEnabled) return;
    const newTargetID = this.tab.sessionID || null;
    if (newTargetID === this.currentTargetID) return;
    this.currentTargetID = newTargetID;
    this.leaveChat();
    if (this.currentTargetID) this.loadForTarget(this.currentTargetID);
  }

  toggleByUser() {
    this.setOpen(this.root.classList.contains('collapsed'), { animate: true, notify: true });
  }

  isOpen() {
    return !!this.root && !this.root.classList.contains('collapsed');
  }

  setOpen(open, { animate, notify, deferInnerRestore = false } = {}) {
    if (!this.root) return;
    const startedAt = performance.now();
    perfLog('setOpen start', { tab: this.tab.id, open, animate, notify, deferInnerRestore });
    const wasOpen = !this.root.classList.contains('collapsed');
    this.tab.aiSidebarOpen = !!open;
    this.cancelPendingInnerHide();
    this.cancelPendingInnerShow();
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
      });
    }
    if (notify && wasOpen !== open) this.onLayoutChange();
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
    let startX = 0;
    let startWidth = 0;
    let resizing = false;
    const onMouseMove = (e) => {
      const next = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, startWidth + (startX - e.clientX)));
      this.root.style.width = next + 'px';
      if (this.inner) this.inner.style.width = next + 'px';
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      this.root.classList.remove('resizing');
      if (resizing) {
        resizing = false;
        this.onResizeEnd();
      }
      saveSidebarWidth(this.tab, parseInt(this.root.style.width, 10));
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
          resizing = false;
          this.onResizeEnd();
        }
      };
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
    return this.renderSessionList();
  }

  async renderSessionList() {
    if (!this.listEl || !this.currentTargetID) return;
    this.listEl.innerHTML = '';

    const newBtn = document.createElement('button');
    newBtn.className = 'btn btn-primary btn-sm';
    newBtn.style.width = '100%';
    newBtn.style.marginBottom = '8px';
    newBtn.textContent = t('aiSidebar.newChat');
    newBtn.addEventListener('click', () => this.handleNewChat());
    this.listEl.appendChild(newBtn);

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
    this.chatsForTarget.forEach(sess => this.listEl.appendChild(this.renderSessionItem(sess)));
  }

  renderSessionItem(sess) {
    const item = document.createElement('div');
    item.className = 'ai-session-item';
    item.dataset.id = sess.id;
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
    if (this.chatEl) {
      this.chatEl.style.display = '';
      if (!sameChat || !this.messagesEl) this.buildChatViewSkeleton(this.chatEl);
    }

    if (this.active) this.subscribeChatEvents(chatID);
    this.setSending(false);
    if (!sameChat || !this.messagesEl) this.lastRenderedSignature = null;
    perfLog('openChat before refresh', this.tab.id, (performance.now() - startedAt).toFixed(1) + 'ms');
    await this.refreshCurrentChat(chatID);
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
  }

  buildChatViewSkeleton(chatView) {
    chatView.innerHTML = '';

    const messages = document.createElement('div');
    messages.className = 'ai-chat-messages';

    const autoexecRow = document.createElement('div');
    autoexecRow.className = 'ai-autoexec-row';
    const label = document.createElement('span');
    label.textContent = t('aiSidebar.autoExecLabel');
    label.title = t('aiSidebar.autoExecDesc');
    const toggle = document.createElement('div');
    toggle.className = 'toggle-switch' + (this.currentAutoExec ? ' on' : '');
    toggle.addEventListener('click', async () => {
      const next = !toggle.classList.contains('on');
      toggle.classList.toggle('on', next);
      this.currentAutoExec = next;
      try { await setAIAutoExec(this.currentChatID, next); } catch (e) { showToast('❌ ' + e); }
    });
    autoexecRow.append(label, toggle);

    const inputRow = document.createElement('div');
    inputRow.className = 'ai-chat-input-row';
    const textarea = document.createElement('textarea');
    textarea.rows = 1;
    textarea.placeholder = t('aiSidebar.inputPlaceholder');
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
    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn btn-primary btn-sm ai-chat-send';
    sendBtn.textContent = t('aiSidebar.send');
    sendBtn.addEventListener('click', () => this.handleSend());
    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn btn-secondary btn-sm ai-chat-stop';
    stopBtn.textContent = t('aiSidebar.stop');
    stopBtn.style.display = 'none';
    stopBtn.addEventListener('click', async () => {
      try { await stopAIRun(this.currentChatID); } catch (e) { showToast('❌ ' + e); }
    });
    inputRow.append(textarea, sendBtn, stopBtn);
    this.messagesEl = messages;
    this.inputEl = textarea;
    this.sendBtn = sendBtn;
    this.stopBtn = stopBtn;

    chatView.append(messages, autoexecRow, inputRow);
  }

  async handleSend() {
    if (!this.inputEl || this.isSending || !this.currentChatID) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = '';
    this.appendUserBubble(text);
    this.setSending(true);
    try {
      await sendAIMessage(this.currentChatID, this.getConnID() || '', text);
    } catch (e) {
      this.appendErrorBubble(String(e));
      this.setSending(false);
    }
  }

  setSending(sending) {
    this.isSending = sending;
    if (this.sendBtn) this.sendBtn.style.display = sending ? 'none' : '';
    if (this.stopBtn) this.stopBtn.style.display = sending ? '' : 'none';
    if (this.inputEl) this.inputEl.disabled = sending;
  }

  subscribeChatEvents(chatID) {
    this.unsubscribeChatEvents();
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

  handleDelta({ content }) {
    this.appendAssistantDelta(content);
  }

  handleToolCall(payload) {
    this.renderPendingToolCard(payload);
  }

  handleToolResult(payload) {
    this.applyToolResult(payload);
  }

  handleToolRejected(payload) {
    this.applyToolRejected(payload);
  }

  handleDone() {
    this.currentAssistantBubble = null;
    this.setSending(false);
  }

  handleError({ message }) {
    this.currentAssistantBubble = null;
    this.appendErrorBubble(t('aiSidebar.chatError', { e: message }));
    this.setSending(false);
  }

  scrollToBottom() {
    if (!this.messagesEl) return;
    if (!this.active || !this.isTerminalActive() || !this.isOpen()) return;
    const startedAt = performance.now();
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    perfLog('scrollToBottom', {
      tab: this.tab.id,
      cost: (performance.now() - startedAt).toFixed(1) + 'ms',
      scrollHeight: this.messagesEl.scrollHeight,
      nodes: this.messagesEl.children.length,
    });
  }

  appendUserBubble(text) {
    const el = document.createElement('div');
    el.className = 'ai-msg user';
    el.textContent = text;
    this.messagesEl?.appendChild(el);
    this.scrollToBottom();
  }

  appendErrorBubble(text) {
    const el = document.createElement('div');
    el.className = 'ai-msg error';
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
    this.currentAssistantBubble.innerHTML = renderMarkdown(this.currentAssistantRaw);
    this.scrollToBottom();
  }

  renderPendingToolCard({ pending_id, tool_call_id, command }) {
    this.currentAssistantBubble = null;
    const card = document.createElement('div');
    card.className = 'ai-tool-card pending';

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
    const outEl = document.createElement('div');
    outEl.className = 'ai-tool-card-output';
    outEl.textContent = output || '(no output)';
    card.appendChild(outEl);
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
        el.textContent = m.content;
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
    if (call.function?.name === 'websearch') command = args.query || '';
    else if (call.function?.name === 'open_url') command = args.url || '';
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
      const outEl = document.createElement('div');
      outEl.className = 'ai-tool-card-output';
      outEl.textContent = resultMsg.content || '(no output)';
      card.appendChild(outEl);
    }

    parent.appendChild(card);
    if (call.id) this.cardsByToolCallID[call.id] = card;
  }
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
  if (tool === 'websearch') return t('aiSidebar.webSearchAction', { q: command || '' });
  if (tool === 'open_url') return t('aiSidebar.openURLAction', { url: command || '' });
  return '$ ' + command;
}
