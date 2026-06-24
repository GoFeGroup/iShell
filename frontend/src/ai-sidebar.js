import {
  listAIChatSessionsForTarget, createAIChatSession, renameAIChatSession, deleteAIChatSession,
  getAIChatMessages, sendAIMessage, approveAIToolCall, rejectAIToolCall, setAIAutoExec,
  stopAIRun, on, off,
} from './api.js';
import { t } from './i18n.js';
import { showToast } from './toast.js';
import { renderMarkdown } from './markdown.js';

// getActiveTerminal() returns null (no terminal tab active) or
// { targetID, connID } — targetID is the bound SSH Session.ID / "__local__"
// (stable across reconnects, shared by simultaneous tabs to the same
// profile); connID is the live connection used for tool-call I/O, re-read
// fresh at send time so it always reflects whichever tab is actually active.
let getActiveTerminal = () => null;

let aiEnabled = false;
let currentTargetID = null;
let chatsForTarget = [];
let currentChatID = null;
let currentAutoExec = false;
let currentAssistantBubble = null;
let currentAssistantRaw = '';
let isSending = false;
let cardsByToolCallID = {};

const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 640;
const DEFAULT_SIDEBAR_WIDTH = 320;

export function initAISidebar(settings, activeTerminalGetter) {
  getActiveTerminal = activeTerminalGetter;
  setAISidebarSettings(settings);
  initResizer();

  document.getElementById('btn-toggle-ai')?.addEventListener('click', toggleAISidebar);
  document.getElementById('ai-close')?.addEventListener('click', () => setSidebarOpen(false));
  document.getElementById('ai-back')?.addEventListener('click', showSessionList);
}

function savedSidebarWidth() {
  try {
    const saved = parseInt(localStorage.getItem('ai-sidebar-width'), 10);
    if (saved >= MIN_SIDEBAR_WIDTH && saved <= MAX_SIDEBAR_WIDTH) return saved;
  } catch { /* ignore */ }
  return DEFAULT_SIDEBAR_WIDTH;
}

// Width is applied as an inline style (not left to the .collapsed CSS class
// alone) so a user-dragged width survives collapse/expand — inline style
// always wins over the class rule, so collapsing must explicitly set 0 too.
function applySidebarWidth() {
  const sidebar = document.getElementById('ai-sidebar');
  if (!sidebar) return;
  sidebar.style.width = sidebar.classList.contains('collapsed') ? '0px' : savedSidebarWidth() + 'px';
}

function initResizer() {
  const resizer = document.getElementById('ai-sidebar-resizer');
  const sidebar = document.getElementById('ai-sidebar');
  if (!resizer || !sidebar) return;
  applySidebarWidth();

  let startX = 0;
  let startWidth = 0;

  function onMouseMove(e) {
    const next = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, startWidth + (startX - e.clientX)));
    sidebar.style.width = next + 'px';
  }
  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    sidebar.classList.remove('resizing');
    try { localStorage.setItem('ai-sidebar-width', parseInt(sidebar.style.width, 10)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('ishell:aiSidebarToggled'));
  }
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (sidebar.classList.contains('collapsed')) return;
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    sidebar.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// Called whenever settings are (re)loaded or saved, so the toolbar entry
// reacts live to the "Enable AI" checkbox without a reload.
export function setAISidebarSettings(settings) {
  aiEnabled = !!settings?.ai_enabled;
  updateToolbarButton();
  if (!aiEnabled) setSidebarOpen(false);
}

// Called by main.js every time the active terminal tab changes (switch,
// connect, disconnect, or leaving to a non-terminal panel) — this is what
// makes each terminal "own" its AI conversation: switching tabs swaps the
// bound chat entirely, and the toolbar entry only shows while a terminal
// tab is actually active.
export function notifyActiveTerminalChanged() {
  updateToolbarButton();
  const resolved = getActiveTerminal();
  const newTargetID = resolved?.targetID || null;
  if (newTargetID === currentTargetID) return;
  currentTargetID = newTargetID;
  leaveChat();
  if (!currentTargetID) return; // sidebar's container is hidden too (not a terminal panel)
  loadForTarget(currentTargetID);
}

function updateToolbarButton() {
  const show = aiEnabled && !!getActiveTerminal();
  const btn = document.getElementById('btn-toggle-ai');
  const vdiv = document.getElementById('ai-toolbar-vdiv');
  if (btn) btn.style.display = show ? '' : 'none';
  if (vdiv) vdiv.style.display = show ? '' : 'none';
}

export function toggleAISidebar() {
  const sidebar = document.getElementById('ai-sidebar');
  if (!sidebar) return;
  setSidebarOpen(sidebar.classList.contains('collapsed'));
}

function setSidebarOpen(open) {
  const sidebar = document.getElementById('ai-sidebar');
  const resizer = document.getElementById('ai-sidebar-resizer');
  if (!sidebar) return;
  const wasOpen = !sidebar.classList.contains('collapsed');
  if (wasOpen === open) return;
  sidebar.classList.toggle('collapsed', !open);
  applySidebarWidth();
  if (resizer) resizer.style.display = open ? '' : 'none';
  // The sidebar takes width away from the terminal next to it — let main.js
  // re-fit the active xterm instance after the CSS width transition.
  window.dispatchEvent(new CustomEvent('ishell:aiSidebarToggled'));
}

// ── Loading a terminal's chats ──────────────────────────────────────────────

async function loadForTarget(targetID) {
  try {
    chatsForTarget = (await listAIChatSessionsForTarget(targetID)) || [];
  } catch (e) {
    console.error('listAIChatSessionsForTarget:', e);
    chatsForTarget = [];
  }
  if (chatsForTarget.length > 0) {
    openChat(chatsForTarget[0].id); // most recently updated
  } else {
    showSessionList();
  }
}

// ── Session list view (other chats for the current terminal) ───────────────

function showSessionList() {
  leaveChat();
  confirmingDeleteID = null;
  const listEl = document.getElementById('ai-session-list');
  const chatEl = document.getElementById('ai-chat-view');
  if (chatEl) chatEl.style.display = 'none';
  if (listEl) listEl.style.display = '';
  const backBtn = document.getElementById('ai-back');
  if (backBtn) backBtn.style.display = 'none';
  renderSessionList();
}

async function renderSessionList() {
  const listEl = document.getElementById('ai-session-list');
  if (!listEl || !currentTargetID) return;
  listEl.innerHTML = '';

  const newBtn = document.createElement('button');
  newBtn.className = 'btn btn-primary btn-sm';
  newBtn.style.width = '100%';
  newBtn.style.marginBottom = '8px';
  newBtn.textContent = t('aiSidebar.newChat');
  newBtn.addEventListener('click', handleNewChat);
  listEl.appendChild(newBtn);

  try {
    chatsForTarget = (await listAIChatSessionsForTarget(currentTargetID)) || [];
  } catch (e) {
    console.error('listAIChatSessionsForTarget:', e);
    showToast('❌ ' + e);
    chatsForTarget = [];
  }

  if (chatsForTarget.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ai-empty';
    empty.textContent = t('aiSidebar.noChats');
    listEl.appendChild(empty);
    return;
  }
  chatsForTarget.forEach(sess => listEl.appendChild(renderSessionItem(sess)));
}

// ID of the row currently armed for delete (showing the inline "Delete? /
// Cancel" confirmation in place of its icons) — at most one at a time.
let confirmingDeleteID = null;

// Single delegated click listener (rather than separate listeners per
// button with stopPropagation) — mirrors sidebar.js's profile-list pattern,
// which is the established, known-working way this codebase tells "open"
// clicks apart from "edit/delete" clicks on a row. Delete/rename avoid the
// native confirm()/prompt() dialogs entirely (inline confirm + inline edit
// instead), since those are an extra, harder-to-debug dependency on the
// host webview's dialog handling.
function renderSessionItem(sess) {
  const item = document.createElement('div');
  item.className = 'ai-session-item';
  item.dataset.id = sess.id;
  const confirming = confirmingDeleteID === sess.id;
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
    if (action === 'rename') { startRename(sess, item); return; }
    if (action === 'delete') { confirmingDeleteID = sess.id; renderSessionList(); return; }
    if (action === 'confirm-delete') { confirmingDeleteID = null; handleDelete(sess); return; }
    if (action === 'cancel-delete') { confirmingDeleteID = null; renderSessionList(); return; }
    if (confirming) return; // row is armed for delete; don't also open the chat
    openChat(sess.id);
  });
  return item;
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Swaps the row's title for an inline <input>, pre-filled with the current
// title; Enter/blur commits, Escape cancels.
function startRename(sess, item) {
  const titleEl = item.querySelector('.ai-session-item-title');
  if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'input ai-session-rename-input';
  input.value = sess.title || '';
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener('click', (e) => e.stopPropagation()); // don't trigger the row's openChat while editing

  let settled = false;
  const commit = async () => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    if (next && next !== sess.title) {
      try { await renameAIChatSession(sess.id, next); } catch (e) { showToast('❌ ' + e); }
    }
    renderSessionList();
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    renderSessionList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
}

async function handleDelete(sess) {
  try {
    await deleteAIChatSession(sess.id);
  } catch (e) {
    showToast('❌ ' + e);
    return;
  }
  if (currentChatID === sess.id) {
    leaveChat();
    showSessionList();
  } else {
    renderSessionList();
  }
}

async function handleNewChat() {
  if (!currentTargetID) return;
  try {
    const sess = await createAIChatSession(currentTargetID, t('aiSidebar.defaultChatTitle'));
    chatsForTarget = [sess, ...chatsForTarget];
    await openChat(sess.id);
  } catch (e) {
    showToast('❌ ' + e);
  }
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Chat view ────────────────────────────────────────────────────────────────

async function openChat(chatID) {
  if (currentChatID && currentChatID !== chatID) {
    unsubscribeChatEvents(currentChatID);
  }
  currentChatID = chatID;
  currentAssistantBubble = null;
  cardsByToolCallID = {};

  const sess = chatsForTarget.find(s => s.id === chatID);
  currentAutoExec = !!sess?.auto_exec;

  const listEl = document.getElementById('ai-session-list');
  const chatEl = document.getElementById('ai-chat-view');
  const backBtn = document.getElementById('ai-back');
  if (listEl) listEl.style.display = 'none';
  if (backBtn) backBtn.style.display = '';
  if (chatEl) {
    chatEl.style.display = '';
    buildChatViewSkeleton(chatEl);
  }

  subscribeChatEvents(chatID);
  setSending(false);

  try {
    const messages = (await getAIChatMessages(chatID)) || [];
    renderHistory(messages);
  } catch (e) {
    console.error('getAIChatMessages:', e);
    showToast('❌ ' + e);
  }
}

function leaveChat() {
  if (currentChatID) unsubscribeChatEvents(currentChatID);
  currentChatID = null;
  currentAssistantBubble = null;
  cardsByToolCallID = {};
}

function buildChatViewSkeleton(chatView) {
  chatView.innerHTML = '';

  const messages = document.createElement('div');
  messages.className = 'ai-chat-messages';
  messages.id = 'ai-chat-messages';

  const autoexecRow = document.createElement('div');
  autoexecRow.className = 'ai-autoexec-row';
  const label = document.createElement('span');
  label.textContent = t('aiSidebar.autoExecLabel');
  label.title = t('aiSidebar.autoExecDesc');
  const toggle = document.createElement('div');
  toggle.className = 'toggle-switch' + (currentAutoExec ? ' on' : '');
  toggle.id = 'ai-autoexec-toggle';
  toggle.addEventListener('click', async () => {
    const next = !toggle.classList.contains('on');
    toggle.classList.toggle('on', next);
    currentAutoExec = next;
    try { await setAIAutoExec(currentChatID, next); } catch (e) { showToast('❌ ' + e); }
  });
  autoexecRow.append(label, toggle);

  const inputRow = document.createElement('div');
  inputRow.className = 'ai-chat-input-row';
  const textarea = document.createElement('textarea');
  textarea.id = 'ai-chat-input';
  textarea.rows = 1;
  textarea.placeholder = t('aiSidebar.inputPlaceholder');
  let composing = false;
  let compositionJustEndedUntil = 0;
  textarea.addEventListener('compositionstart', () => {
    composing = true;
  });
  textarea.addEventListener('compositionend', () => {
    composing = false;
    compositionJustEndedUntil = Date.now() + 80;
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.isComposing || composing || e.keyCode === 229 || Date.now() < compositionJustEndedUntil) return;
      e.preventDefault();
      handleSend();
    }
  });
  const sendBtn = document.createElement('button');
  sendBtn.className = 'btn btn-primary btn-sm';
  sendBtn.id = 'ai-chat-send';
  sendBtn.textContent = t('aiSidebar.send');
  sendBtn.addEventListener('click', handleSend);
  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn btn-secondary btn-sm';
  stopBtn.id = 'ai-chat-stop';
  stopBtn.textContent = t('aiSidebar.stop');
  stopBtn.style.display = 'none';
  stopBtn.addEventListener('click', async () => {
    try { await stopAIRun(currentChatID); } catch (e) { showToast('❌ ' + e); }
  });
  inputRow.append(textarea, sendBtn, stopBtn);

  chatView.append(messages, autoexecRow, inputRow);
}

async function handleSend() {
  const textarea = document.getElementById('ai-chat-input');
  if (!textarea || isSending || !currentChatID) return;
  const text = textarea.value.trim();
  if (!text) return;
  textarea.value = '';
  appendUserBubble(text);
  setSending(true);
  try {
    await sendAIMessage(currentChatID, getActiveTerminal()?.connID || '', text);
  } catch (e) {
    appendErrorBubble(String(e));
    setSending(false);
  }
}

function setSending(sending) {
  isSending = sending;
  const sendBtn = document.getElementById('ai-chat-send');
  const stopBtn = document.getElementById('ai-chat-stop');
  const textarea = document.getElementById('ai-chat-input');
  if (sendBtn) sendBtn.style.display = sending ? 'none' : '';
  if (stopBtn) stopBtn.style.display = sending ? '' : 'none';
  if (textarea) textarea.disabled = sending;
}

// ── Event subscriptions (live streaming) ────────────────────────────────────

function subscribeChatEvents(chatID) {
  on('ai:delta:' + chatID, handleDelta);
  on('ai:tool_call:' + chatID, handleToolCall);
  on('ai:tool_result:' + chatID, handleToolResult);
  on('ai:tool_rejected:' + chatID, handleToolRejected);
  on('ai:done:' + chatID, handleDone);
  on('ai:error:' + chatID, handleError);
}

function unsubscribeChatEvents(chatID) {
  off('ai:delta:' + chatID);
  off('ai:tool_call:' + chatID);
  off('ai:tool_result:' + chatID);
  off('ai:tool_rejected:' + chatID);
  off('ai:done:' + chatID);
  off('ai:error:' + chatID);
}

function handleDelta({ content }) {
  appendAssistantDelta(content);
}

function handleToolCall(payload) {
  renderPendingToolCard(payload);
}

function handleToolResult(payload) {
  applyToolResult(payload);
}

function handleToolRejected(payload) {
  applyToolRejected(payload);
}

function handleDone() {
  currentAssistantBubble = null;
  setSending(false);
}

function handleError({ message }) {
  currentAssistantBubble = null;
  appendErrorBubble(t('aiSidebar.chatError', { e: message }));
  setSending(false);
}

// ── Message rendering (live) ─────────────────────────────────────────────────

function messagesContainer() {
  return document.getElementById('ai-chat-messages');
}

function scrollToBottom() {
  const c = messagesContainer();
  if (c) c.scrollTop = c.scrollHeight;
}

function appendUserBubble(text) {
  const el = document.createElement('div');
  el.className = 'ai-msg user';
  el.textContent = text;
  messagesContainer()?.appendChild(el);
  scrollToBottom();
}

function appendErrorBubble(text) {
  const el = document.createElement('div');
  el.className = 'ai-msg error';
  el.textContent = text;
  messagesContainer()?.appendChild(el);
  scrollToBottom();
}

function appendAssistantDelta(content) {
  if (!currentAssistantBubble) {
    currentAssistantBubble = document.createElement('div');
    currentAssistantBubble.className = 'ai-msg assistant';
    messagesContainer()?.appendChild(currentAssistantBubble);
    currentAssistantRaw = '';
  }
  currentAssistantRaw += content;
  // Markdown is re-parsed from the full accumulated text on every chunk —
  // simpler and robust to streaming splitting tokens mid-syntax (e.g. a
  // fenced code block opened in one delta, closed several deltas later).
  currentAssistantBubble.innerHTML = renderMarkdown(currentAssistantRaw);
  scrollToBottom();
}

function renderPendingToolCard({ pending_id, tool_call_id, command }) {
  currentAssistantBubble = null; // next delta (if any) starts a fresh bubble

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
  messagesContainer()?.appendChild(card);
  scrollToBottom();
  cardsByToolCallID[tool_call_id] = card;
}

function applyToolResult({ tool_call_id, tool, command, output }) {
  currentAssistantBubble = null;
  const card = cardOrPlaceholder(tool_call_id, tool, command);
  card.className = 'ai-tool-card done';
  card.querySelector('.ai-tool-card-actions')?.remove();
  card.querySelector('.ai-tool-card-status')?.remove();
  const outEl = document.createElement('div');
  outEl.className = 'ai-tool-card-output';
  outEl.textContent = output || '(no output)';
  card.appendChild(outEl);
  scrollToBottom();
}

function applyToolRejected({ tool_call_id }) {
  currentAssistantBubble = null;
  const card = cardsByToolCallID[tool_call_id];
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
  scrollToBottom();
}

// Returns the existing pending card for tool_call_id, or builds a fresh one
// — needed because auto-executed tool calls never go through
// renderPendingToolCard (no approval card was ever shown).
function cardOrPlaceholder(toolCallID, tool, command) {
  let card = cardsByToolCallID[toolCallID];
  if (card) return card;
  card = document.createElement('div');
  card.className = 'ai-tool-card';
  const cmdEl = document.createElement('div');
  cmdEl.className = 'ai-tool-card-command';
  cmdEl.textContent = toolLabel(tool, command);
  card.appendChild(cmdEl);
  messagesContainer()?.appendChild(card);
  cardsByToolCallID[toolCallID] = card;
  return card;
}

function toolLabel(tool, command) {
  if (tool === 'terminal_read') return t('aiSidebar.readAction');
  if (tool === 'websearch') return t('aiSidebar.webSearchAction', { q: command || '' });
  return '$ ' + command;
}

// ── History rendering (on chat open) ────────────────────────────────────────

function renderHistory(messages) {
  const container = messagesContainer();
  if (!container) return;
  container.innerHTML = '';
  cardsByToolCallID = {};
  currentAssistantBubble = null;

  const toolResultsByID = {};
  messages.forEach(m => {
    if (m.role === 'tool' && m.tool_call_id) toolResultsByID[m.tool_call_id] = m;
  });

  messages.forEach(m => {
    if (m.role === 'user') {
      const el = document.createElement('div');
      el.className = 'ai-msg user';
      el.textContent = m.content;
      container.appendChild(el);
    } else if (m.role === 'assistant') {
      if (m.content) {
        const el = document.createElement('div');
        el.className = 'ai-msg assistant';
        el.innerHTML = renderMarkdown(m.content);
        container.appendChild(el);
      }
      if (m.tool_calls) {
        let calls = [];
        try { calls = JSON.parse(m.tool_calls); } catch { calls = []; }
        calls.forEach(call => renderHistoricalToolCall(call, toolResultsByID[call.id]));
      }
    }
  });
  scrollToBottom();
}

function renderHistoricalToolCall(call, resultMsg) {
  const container = messagesContainer();
  if (!container) return;

  let args = {};
  try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
  const command = call.function?.name === 'websearch' ? (args.query || '') : (args.command || '');
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

  container.appendChild(card);
  if (call.id) cardsByToolCallID[call.id] = card;
}
