import {
  listRemoteDir, listLocalDir,
  makeRemoteDir, deleteRemote, renameRemote, setPermissions,
  uploadFiles, uploadSpecific, downloadFilesToDir, on,
  getDownloadsDir, getRemotePWD, getSFTPTransfers, clearFinishedSFTPTransfers,
  cancelSFTPTransfer,
} from './api.js';
import { getTerminalCWD } from './terminal.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';
import { confirmDialog, promptDialog } from './confirm-dialog.js';

let connID = null;
let localPath = '';
let remotePath = '';
const transfers = {};
let lastSelected = { local: null, remote: null };
let dragState = null;
let cwdListener = null;
let progressListenerRegistered = false;
const stateByConn = {};

window.addEventListener('ishell:languageChanged', () => {
  Object.values(stateByConn).forEach(s => { s.rendered = false; });
  if (connID && document.getElementById('panel-sftp')?.style.display !== 'none') {
    renderSFTP();
    loadTransferQueue();
    Promise.all([loadLocal(), loadRemote()]);
    stateByConn[connID].rendered = true;
  }
});

export async function initSFTP(cID) {
  // Clean up previous CWD listener before re-initializing
  if (cwdListener) {
    window.removeEventListener('terminal:cwd:' + cwdListener.connID, cwdListener.handler);
    cwdListener = null;
  }

  connID = cID;
  const state = stateByConn[connID] || (stateByConn[connID] = {});
  const firstInit = !state.rendered;
  localPath = state.localPath || await getDownloadsDir();

  // Priority 1: CWD tracked from terminal OSC sequences (accurate, reflects terminal navigation)
  // Priority 2: SFTP session default dir (user home on most servers)
  // Priority 3: root
  remotePath = state.remotePath || getTerminalCWD(connID);
  if (!remotePath) {
    try {
      remotePath = await getRemotePWD(connID);
    } catch (e) {
      console.error('getRemotePWD failed:', e);
      remotePath = '/';
    }
  }

  // Listen for transfer progress before loading the queue to avoid missing
  // updates that arrive while the panel is being rebuilt.
  if (!progressListenerRegistered) {
    on('sftp:progress', (prog) => handleProgress(prog));
    progressListenerRegistered = true;
  }

  if (firstInit) {
    renderSFTP();
    await loadTransferQueue();
    await Promise.all([loadLocal(), loadRemote()]).catch(e => showToast('❌ ' + e));
    state.rendered = true;
  } else {
    restoreSFTPState();
    updateQueueBadge();
  }

  // Update remote pane when terminal CWD changes.
  const handler = (e) => {
    if (document.getElementById('panel-sftp')?.style.display === 'none') return;
    if (e.detail !== remotePath) {
      remotePath = e.detail;
      saveCurrentState();
      loadRemote();
    }
  };
  window.addEventListener('terminal:cwd:' + connID, handler);
  cwdListener = { connID, handler };
}

function saveCurrentState() {
  if (!connID) return;
  stateByConn[connID] = {
    ...(stateByConn[connID] || {}),
    rendered: true,
    localPath,
    remotePath,
  };
}

function restoreSFTPState() {
  setBreadcrumb('local', localPath);
  setBreadcrumb('remote', remotePath);
  bindHeaderCb('local');
  bindHeaderCb('remote');
}

function renderSFTP() {
  const panel = document.getElementById('panel-sftp');
  panel.innerHTML = `
<div class="sftp-layout">
  <div class="sftp-body" id="sftp-body">
    <!-- Local pane -->
    <div class="sftp-pane" id="pane-local"
         ondragover="window._sftp.onDragOver(event,'local')"
         ondragleave="window._sftp.onDragLeave('local')"
         ondrop="window._sftp.onDrop(event,'local')">
      <div class="sftp-pane-header">
        <span class="pane-label">${t('sftp.localPane')}</span>
        <div class="breadcrumb" id="bc-local"></div>
      </div>
      <div class="pane-toolbar">
        <button class="btn btn-ghost btn-icon btn-sm" onclick="window._sftp.navLocalUp()" title="${t('common.up')}">↑</button>
        <button class="btn btn-ghost btn-icon btn-sm" onclick="window._sftp.refreshLocal()" title="${t('common.refresh')}">↺</button>
        <div class="pane-toolbar-sep"></div>
        <button class="btn btn-ghost btn-sm" style="font-size:12px;" onclick="window._sftp.uploadSelected()">${t('sftp.uploadBtn')}</button>
      </div>
      <div class="file-list" id="list-local">
        <div class="file-list-header">
          <span><input type="checkbox" id="cb-all-local" style="accent-color:var(--accent);" /></span>
          <span>${t('sftp.colName')}</span><span style="text-align:right;">${t('sftp.colSize')}</span><span>${t('sftp.colModified')}</span><span>${t('sftp.colType')}</span>
        </div>
      </div>
      <div class="drop-overlay" id="drop-local"><div class="drop-msg">${t('sftp.dropToDownload')}</div></div>
    </div>

    <!-- Mid strip -->
    <div class="sftp-mid">
      <div>
        <button class="transfer-btn" title="${t('sftp.uploadSelectedTitle')}" onclick="window._sftp.uploadSelected()">→</button>
        <div style="font-size:9px;color:var(--text-muted);text-align:center;margin-top:3px;">${t('common.upload')}</div>
      </div>
      <div>
        <button class="transfer-btn" title="${t('sftp.downloadSelectedTitle')}" onclick="window._sftp.downloadSelected()">←</button>
        <div style="font-size:9px;color:var(--text-muted);text-align:center;margin-top:3px;">${t('common.download')}</div>
      </div>
    </div>

    <!-- Remote pane -->
    <div class="sftp-pane" id="pane-remote"
         ondragover="window._sftp.onDragOver(event,'remote')"
         ondragleave="window._sftp.onDragLeave('remote')"
         ondrop="window._sftp.onDrop(event,'remote')">
      <div class="sftp-pane-header">
        <span class="pane-label">${t('sftp.remotePane')}</span>
        <div class="breadcrumb" id="bc-remote"></div>
      </div>
      <div class="pane-toolbar">
        <button class="btn btn-ghost btn-icon btn-sm" onclick="window._sftp.navRemoteUp()" title="${t('common.up')}">↑</button>
        <button class="btn btn-ghost btn-icon btn-sm" onclick="window._sftp.refreshRemote()" title="${t('common.refresh')}">↺</button>
        <div class="pane-toolbar-sep"></div>
        <button class="btn btn-ghost btn-sm" style="font-size:12px;" onclick="window._sftp.downloadSelected()">${t('sftp.downloadBtn')}</button>
      </div>
      <div class="file-list" id="list-remote">
        <div class="file-list-header">
          <span><input type="checkbox" id="cb-all-remote" style="accent-color:var(--accent);" /></span>
          <span>${t('sftp.colName')}</span><span style="text-align:right;">${t('sftp.colSize')}</span><span>${t('sftp.colModified')}</span><span>${t('sftp.colPerms')}</span>
        </div>
      </div>
      <div class="drop-overlay" id="drop-remote"><div class="drop-msg">${t('sftp.dropToDownload')}</div></div>
    </div>
  </div>

  <!-- Transfer queue -->
  <div class="transfer-queue">
    <div class="queue-header" onclick="window._sftp.toggleQueue()">
      <div class="queue-title">${t('sftp.transfersTitle')} <span class="badge badge-blue" id="queue-badge" style="display:none;"></span></div>
      <div class="queue-actions">
        <button class="queue-clear" id="queue-clear" onclick="event.stopPropagation(); window._sftp.clearFinishedTransfers()" disabled>${t('common.clear')}</button>
        <span id="queue-arrow" style="color:var(--text-muted);font-size:12px;">▼</span>
      </div>
    </div>
    <div class="queue-body" id="queue-body"></div>
  </div>
</div>`;

  bindHeaderCb('local');
  bindHeaderCb('remote');
}

// ── File loading ──────────────────────────────────────────────────────────────

async function loadLocal() {
  setBreadcrumb('local', localPath);
  saveCurrentState();
  const list = document.getElementById('list-local');
  list.innerHTML = `<div class="file-list-header"><span><input type="checkbox" id="cb-all-local" style="accent-color:var(--accent);" /></span><span>${t('sftp.colName')}</span><span style="text-align:right;">${t('sftp.colSize')}</span><span>${t('sftp.colModified')}</span><span>${t('sftp.colType')}</span></div>`;
  bindHeaderCb('local');
  try {
    const files = await listLocalDir(localPath);
    renderFiles(list, files, 'local');
  } catch (e) {
    showToast('❌ ' + e);
  }
}

async function loadRemote() {
  setBreadcrumb('remote', remotePath);
  saveCurrentState();
  const list = document.getElementById('list-remote');
  list.innerHTML = `<div class="file-list-header"><span><input type="checkbox" id="cb-all-remote" style="accent-color:var(--accent);" /></span><span>${t('sftp.colName')}</span><span style="text-align:right;">${t('sftp.colSize')}</span><span>${t('sftp.colModified')}</span><span>${t('sftp.colPerms')}</span></div>`;
  bindHeaderCb('remote');
  try {
    const files = await listRemoteDir(connID, remotePath);
    renderFiles(list, files, 'remote');
  } catch (e) {
    showToast('❌ ' + e);
  }
}

function renderFiles(listEl, files, pane) {
  // Sort: dirs first, then by name
  files.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  files.forEach(f => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.name = f.name;
    row.dataset.path = f.path;
    row.dataset.isdir = f.is_dir;
    const icon = f.is_dir ? '📁' : fileIcon(f.name);
    const size = f.is_dir ? '—' : fmtSize(f.size);
    const date = fmtDate(f.mod_time);
    const perms = f.mode || '';
    row.innerHTML = `
      <span><input type="checkbox" style="accent-color:var(--accent);" /></span>
      <span class="file-name"><span class="file-icon">${icon}</span>${f.is_dir ? `<span class="is-dir">${escHtml(f.name)}</span>` : escHtml(f.name)}</span>
      <span class="file-size">${size}</span>
      <span class="file-date">${date}</span>
      <span class="file-perms">${perms}</span>`;

    // Click = toggle selection
    row.addEventListener('click', e => {
      if (e.shiftKey) {
        rangeSelect(row, pane);
      } else {
        toggleRowSelected(row, pane);
      }
      updateHeaderCb(pane);
    });

    // Double-click = navigate into dir
    row.addEventListener('dblclick', () => {
      if (f.is_dir) {
        if (pane === 'local') { localPath = f.path; saveCurrentState(); loadLocal(); }
        else { remotePath = f.path; saveCurrentState(); loadRemote(); }
      }
    });

    // Right-click context menu
    row.addEventListener('contextmenu', e => showCtxMenu(e, f, pane));

    // Drag (files and directories)
    row.setAttribute('draggable', 'true');
    row.addEventListener('dragstart', e => onRowDragStart(e, pane, row, f));
    row.addEventListener('dragend', onRowDragEnd);
    row.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); onRowDragOverRow(e, row); });

    listEl.appendChild(row);
  });
}

// ── Selection ─────────────────────────────────────────────────────────────────

function getRows(pane) {
  return Array.from(document.querySelectorAll(`#list-${pane} .file-row`));
}
function getSelectedRows(pane) {
  return getRows(pane).filter(r => r.classList.contains('selected'));
}
function setRowSelected(row, sel) {
  row.classList.toggle('selected', sel);
  const cb = row.querySelector('input[type="checkbox"]');
  if (cb) cb.checked = sel;
}
function toggleRowSelected(row, pane) {
  const next = !row.classList.contains('selected');
  setRowSelected(row, next);
  lastSelected[pane] = row;
}
function rangeSelect(row, pane) {
  const rows = getRows(pane);
  const anchor = lastSelected[pane];
  if (!anchor || !rows.includes(anchor)) { toggleRowSelected(row, pane); return; }
  const a = rows.indexOf(anchor), b = rows.indexOf(row);
  const lo = Math.min(a,b), hi = Math.max(a,b);
  rows.forEach((r,i) => setRowSelected(r, i>=lo && i<=hi));
}
function updateHeaderCb(pane) {
  const cb = document.getElementById('cb-all-' + pane);
  if (!cb) return;
  const rows = getRows(pane);
  const sel = rows.filter(r=>r.classList.contains('selected')).length;
  cb.checked = sel === rows.length && rows.length > 0;
  cb.indeterminate = sel > 0 && sel < rows.length;
}
function bindHeaderCb(pane) {
  const cb = document.getElementById('cb-all-' + pane);
  if (!cb) return;
  if (cb.dataset.bound === '1') return;
  cb.dataset.bound = '1';
  cb.addEventListener('change', e => {
    const checked = e.target.checked;
    getRows(pane).forEach(r => setRowSelected(r, checked));
    lastSelected[pane] = checked ? getRows(pane).at(-1) || null : null;
    updateHeaderCb(pane);
  });
}

// ── Drag & drop ───────────────────────────────────────────────────────────────

function onRowDragStart(e, pane, draggedRow, file) {
  if (!draggedRow.classList.contains('selected')) {
    getRows(pane).forEach(r => setRowSelected(r, false));
    setRowSelected(draggedRow, true);
    lastSelected[pane] = draggedRow;
    updateHeaderCb(pane);
  }
  const selected = getSelectedRows(pane).map(r => ({ name: r.dataset.name, path: r.dataset.path }));
  dragState = { srcPane: pane, files: selected };
  getSelectedRows(pane).forEach(r => r.classList.add('dragging'));

  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', selected.map(f=>f.name).join('\n'));

  const ghost = document.createElement('div');
  ghost.style.cssText = 'position:fixed;top:-200px;background:var(--bg-elevated);border:1px solid var(--border);padding:5px 14px;border-radius:6px;font-size:13px;color:var(--text-primary);white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.4);pointer-events:none;';
  const dest = pane === 'local' ? 'remote' : 'local';
  ghost.textContent = selected.length === 1 ? `${fileIcon(selected[0].name)} ${selected[0].name} → ${dest}` : `📦 ${selected.length} files → ${dest}`;
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 0, 24);
  setTimeout(() => ghost.remove(), 0);
}
function onRowDragEnd() {
  document.querySelectorAll('.file-row.dragging').forEach(r => r.classList.remove('dragging'));
  document.querySelectorAll('.file-row.drag-over-row').forEach(r => r.classList.remove('drag-over-row'));
  document.querySelectorAll('.drop-overlay.visible').forEach(o => o.classList.remove('visible'));
  dragState = null;
}
function onRowDragOverRow(e, row) {
  document.querySelectorAll('.file-row.drag-over-row').forEach(r => r.classList.remove('drag-over-row'));
  row.classList.add('drag-over-row');
}
window._sftp = window._sftp || {};
window._sftp.onDragOver = (e, pane) => {
  e.preventDefault();
  if (!dragState || dragState.srcPane !== pane) {
    document.getElementById('drop-' + pane)?.classList.add('visible');
  }
};
window._sftp.onDragLeave = (pane) => {
  document.getElementById('drop-' + pane)?.classList.remove('visible');
};
window._sftp.onDrop = async (e, targetPane) => {
  e.preventDefault();
  document.getElementById('drop-' + targetPane)?.classList.remove('visible');
  document.querySelectorAll('.file-row.drag-over-row').forEach(r => r.classList.remove('drag-over-row'));
  if (dragState) {
    if (dragState.srcPane === targetPane) { dragState = null; return; }
    if (targetPane === 'remote') {
      // local → remote: upload
      const lps = dragState.files.map(f => f.path);
      await doUploadPaths(lps);
    } else {
      // remote → local: download directly to current local directory
      const rps = dragState.files.map(f => f.path);
      await doDownloadToDir(rps, localPath);
    }
    dragState = null;
  }
};

// ── Transfers ─────────────────────────────────────────────────────────────────

window._sftp.uploadSelected = async () => {
  const sel = getSelectedRows('local');
  if (sel.length === 0) { await doUploadDialog(); return; }
  const lps = sel.map(r => r.dataset.path);
  await doUploadPaths(lps);
};
window._sftp.downloadSelected = async () => {
  const sel = getSelectedRows('remote');
  if (sel.length === 0) { showToast(t('sftp.selectFilesToDownload')); return; }
  const rps = sel.map(r => r.dataset.path);
  await doDownloadToDir(rps, localPath);
};

async function doUploadDialog() {
  try {
    const ids = await uploadFiles(connID, remotePath);
    if (ids) { ids.forEach(id => addQueueItem(id, '📄 file', 'upload')); }
    setTimeout(loadRemote, 500);
  } catch (e) { showToast('❌ ' + e); }
}
async function doUploadPaths(localPaths) {
  // For drag-dropped paths we use the specific upload API
  try {
    const ids = await uploadSpecific(connID, localPaths, remotePath);
    if (ids) {
      localPaths.forEach((lp, i) => {
        const name = lp.split(/[/\\]/).pop();
        addQueueItem(ids[i] || 'id-'+i, name, 'upload');
      });
    }
    setTimeout(loadRemote, 500);
  } catch (e) { showToast('❌ ' + e); }
}
async function doDownloadToDir(remotePaths, localDir) {
  try {
    const ids = await downloadFilesToDir(connID, remotePaths, localDir);
    if (ids) {
      remotePaths.forEach((rp, i) => {
        const name = rp.split('/').pop();
        addQueueItem(ids[i] || 'id-'+i, name, 'download');
      });
    }
    setTimeout(loadLocal, 500);
  } catch (e) { showToast('❌ ' + e); }
}

async function loadTransferQueue() {
  try {
    const records = await getSFTPTransfers(connID);
    Object.keys(transfers).forEach(id => delete transfers[id]);
    const body = document.getElementById('queue-body');
    if (body) body.innerHTML = '';
    (records || [])
      .sort((a, b) => (a.started_at || '').localeCompare(b.started_at || ''))
      .forEach(rec => {
        addQueueItem(rec.transfer_id, rec.name || rec.remote_path?.split('/').pop() || 'file', rec.action || 'download');
        handleProgress(rec, { silent: true });
      });
  } catch (e) {
    console.error('load SFTP transfers failed:', e);
  }
}

function addQueueItem(transferID, name, action) {
  if (!transferID) return;
  transfers[transferID] = transfers[transferID] || { name, action, finished: false };
  transfers[transferID].name = name;
  transfers[transferID].action = action;

  const body = document.getElementById('queue-body');
  if (!body || document.getElementById('qi-' + transferID)) {
    updateQueueBadge();
    return;
  }

  const isUp = action === 'upload';
  const item = document.createElement('div');
  item.className = 'queue-item';
  item.id = 'qi-' + transferID;
  item.innerHTML = `
    <span class="queue-file-icon">${isUp?'⬆':'⬇'}</span>
    <div class="queue-file-info">
      <div class="queue-file-name">${escHtml(name)}</div>
      <div class="queue-progress-row">
        <div class="progress-bar"><div class="progress-fill ${isUp?'uploading':'downloading'}" id="pf-${transferID}" style="width:0%;"></div></div>
        <span class="queue-pct" id="pp-${transferID}">0%</span>
        <span class="queue-speed" id="ps-${transferID}">—</span>
      </div>
    </div>
    <span class="queue-direction ${isUp?'up':'down'}" id="pd-${transferID}">${isUp?t('sftp.queueUpload'):t('sftp.queueDownload')}</span>
    <button class="queue-cancel" id="qc-${transferID}" onclick="window._sftp.cancelTransfer('${transferID}')">✕</button>`;
  body.insertBefore(item, body.firstChild);
  updateQueueBadge();
}

window._sftp.cancelTransfer = async (transferID) => {
  const tr = transfers[transferID];
  if (!tr || tr.finished) {
    document.getElementById('qi-' + transferID)?.remove();
    return;
  }
  const btn = document.getElementById('qc-' + transferID);
  if (btn) btn.disabled = true;
  try {
    await cancelSFTPTransfer(transferID);
  } catch (e) {
    if (btn) btn.disabled = false;
    showToast('❌ ' + e);
  }
};

function handleProgress(prog, opts = {}) {
  const transferID = prog.transfer_id;
  if (!transferID) return;
  if (prog.conn_id && connID && prog.conn_id !== connID) return;

  const existing = transfers[transferID] || {};
  const action = prog.action || existing.action || 'download';
  const name = prog.name || existing.name || prog.remote_path?.split('/').pop() || 'file';
  transfers[transferID] = { ...existing, name, action, finished: !!prog.finished, cancelled: !!prog.cancelled, error: prog.error || '' };

  if (!document.getElementById('qi-' + transferID) && document.getElementById('queue-body')) {
    addQueueItem(transferID, name, action);
  }

  const pf = document.getElementById('pf-' + prog.transfer_id);
  const pp = document.getElementById('pp-' + prog.transfer_id);
  const ps = document.getElementById('ps-' + prog.transfer_id);
  const pd = document.getElementById('pd-' + prog.transfer_id);
  if (!pf) return;
  const pct = Math.round(prog.percent);
  const scanning = !prog.finished && (!prog.total || prog.total <= 0);
  pf.style.width = scanning ? '8%' : pct + '%';
  pp.textContent = prog.finished ? t('sftp.statusDone') : scanning ? t('sftp.statusScanning') : pct + '%';
  if (prog.speed_bps > 0) ps.textContent = fmtSize(prog.speed_bps) + '/s';
  if (prog.finished) {
    const btn = document.getElementById('qc-' + prog.transfer_id);
    if (btn) btn.disabled = false;
  }
  if (prog.cancelled) {
    pf.className = 'progress-fill cancelled';
    pp.textContent = t('sftp.statusCancelled'); pp.style.color = '';
    if (pd) { pd.className = 'queue-direction cancelled'; pd.textContent = t('sftp.queueCancelledMark'); }
    if (!opts.silent) showToast(t('toast.transferCancelled', { name }));
    transfers[prog.transfer_id].finished = true;
    updateQueueBadge();
  } else if (prog.error) {
    pf.className = 'progress-fill errored'; pf.style.width='100%';
    pp.textContent = t('sftp.statusError'); pp.style.color = 'var(--red)';
    if (pd) { pd.className = 'queue-direction error'; pd.textContent = t('sftp.queueFailedMark'); }
    if (!opts.silent) showToast(t('toast.transferFailed', { err: prog.error }));
    transfers[prog.transfer_id].finished = true;
    transfers[prog.transfer_id].error = prog.error;
    updateQueueBadge();
  } else if (prog.finished) {
    pf.className = 'progress-fill done';
    if (pd) { pd.className = 'queue-direction done'; pd.textContent = t('sftp.queueDoneMark'); }
    transfers[prog.transfer_id].finished = true;
    updateQueueBadge();
    if (!opts.silent && prog.name) showToast(t('toast.transferDone', { name: prog.name }));
  }
}

function updateQueueBadge() {
  const badge = document.getElementById('queue-badge');
  const n = Object.values(transfers).filter(tr => !tr.finished).length;
  if (badge) { badge.textContent = t('sftp.activeBadge', { n }); badge.style.display = n > 0 ? '' : 'none'; }
  const clear = document.getElementById('queue-clear');
  if (clear) clear.disabled = !Object.values(transfers).some(tr => tr.finished);
}

window._sftp.toggleQueue = () => {
  const body = document.getElementById('queue-body');
  const arrow = document.getElementById('queue-arrow');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (arrow) arrow.textContent = open ? '▶' : '▼';
};

window._sftp.clearFinishedTransfers = async () => {
  try {
    await clearFinishedSFTPTransfers(connID);
    Object.entries(transfers).forEach(([id, transfer]) => {
      if (transfer.finished) {
        delete transfers[id];
        document.getElementById('qi-' + id)?.remove();
      }
    });
    updateQueueBadge();
  } catch (e) {
    showToast('❌ ' + e);
  }
};

// ── Navigation ────────────────────────────────────────────────────────────────

window._sftp.navLocalUp = () => {
  const parts = localPath.replace(/\\/g,'/').split('/').filter(Boolean);
  if (parts.length > 0) {
    parts.pop();
    localPath = (parts.length ? '/' + parts.join('/') : '/');
    // Windows drive letter fix
    if (/^\/[A-Za-z]$/.test(localPath)) localPath = localPath.slice(1) + ':\\';
  }
  saveCurrentState();
  loadLocal();
};
window._sftp.navRemoteUp = () => {
  const parts = remotePath.split('/').filter(Boolean);
  if (parts.length > 0) parts.pop();
  remotePath = '/' + parts.join('/') || '/';
  saveCurrentState();
  loadRemote();
};
window._sftp.refreshLocal  = loadLocal;
window._sftp.refreshRemote = loadRemote;

function setBreadcrumb(pane, path) {
  const el = document.getElementById('bc-' + pane);
  if (!el) return;
  const normalized = (path || '/').replace(/\\/g,'/');
  const parts = normalized.split('/').filter(Boolean);
  el.replaceChildren();
  const addSegment = (label, target) => {
    const segment = document.createElement('span');
    segment.className = 'breadcrumb-seg';
    segment.textContent = label;
    segment.addEventListener('click', () => window._sftp.navTo(pane, target));
    el.appendChild(segment);
  };
  addSegment('/', '/');
  parts.forEach((part, i) => {
    addSegment(part, '/' + parts.slice(0, i + 1).join('/'));
    const separator = document.createElement('span');
    separator.className = 'breadcrumb-sep';
    separator.textContent = '/';
    el.appendChild(separator);
  });
}
window._sftp.navTo = (pane, path) => {
  if (pane === 'local') { localPath = path; saveCurrentState(); loadLocal(); }
  else { remotePath = path; saveCurrentState(); loadRemote(); }
};

// ── Context menu ──────────────────────────────────────────────────────────────

function showCtxMenu(e, file, pane) {
  e.preventDefault();
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.cssText = `left:${e.pageX}px;top:${e.pageY}px;`;
  const items = pane === 'local' ? [
    { label: t('sftp.ctxUpload'), action: () => doUploadPaths([file.path]) },
    { label: t('sftp.ctxRename'), action: () => renamePrompt(file, pane) },
    null,
    { label: t('sftp.ctxDelete'), cls: 'danger', action: () => localDeletePrompt(file) },
  ] : [
    { label: t('sftp.ctxDownload'), action: () => doDownloadToDir([file.path], localPath) },
    { label: t('sftp.ctxRename'), action: () => renamePrompt(file, pane) },
    { label: t('sftp.ctxPermissions'), action: () => permDialog(file) },
    null,
    { label: t('sftp.ctxDelete'), cls: 'danger', action: () => remoteDeletePrompt(file) },
  ];
  items.forEach(item => {
    if (!item) { const d=document.createElement('div'); d.className='ctx-divider'; menu.appendChild(d); return; }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (item.cls ? ' ' + item.cls : '');
    el.textContent = item.label;
    el.addEventListener('click', () => { menu.remove(); item.action(); });
    menu.appendChild(el);
  });
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

async function renamePrompt(file, pane) {
  const newName = await promptDialog(t('sftp.renamePrompt', { name: file.name }), file.name);
  if (!newName || newName === file.name) return;
  const normalizedPath = file.path.replace(/\\/g, '/');
  const dir = normalizedPath.substring(0, normalizedPath.lastIndexOf('/') + 1);
  const newPath = (pane === 'remote' ? dir : '') + newName;
  if (pane === 'remote') {
    renameRemote(connID, file.path, dir + newName)
      .then(() => loadRemote()).catch(e => showToast('❌ ' + e));
  } else {
    showToast(t('sftp.renameLocalUnsupported'));
  }
}
async function remoteDeletePrompt(file) {
  if (!(await confirmDialog(t('sftp.confirmDeleteRemote', { name: file.name })))) return;
  deleteRemote(connID, file.path).then(() => loadRemote()).catch(e => showToast('❌ ' + e));
}
function localDeletePrompt(file) {
  showToast(t('sftp.deleteLocalUnsupported'));
}
async function permDialog(file) {
  const oct = await promptDialog(t('sftp.permPrompt', { name: file.name }), '644');
  if (!oct) return;
  const mode = parseInt(oct, 8);
  setPermissions(connID, file.path, mode).then(() => loadRemote()).catch(e => showToast('❌ ' + e));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSize(b) {
  if (b === 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}
function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('sv').slice(0,16);
}
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','gif','bmp','webp','svg'].includes(ext)) return '🖼';
  if (['zip','tar','gz','bz2','xz','rar','7z'].includes(ext)) return '📦';
  if (['mp4','mkv','avi','mov'].includes(ext)) return '🎬';
  if (['mp3','wav','flac'].includes(ext)) return '🎵';
  if (['pdf'].includes(ext)) return '📕';
  if (['go','js','ts','py','rs','java','c','cpp','h'].includes(ext)) return '📝';
  return '📄';
}
function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return (s||'').replace(/'/g,"\\'"); }
