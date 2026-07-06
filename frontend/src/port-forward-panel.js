import { listPortForwardsForSession, listActiveForwards, startPortForward, startAdHocForward, stopPortForward } from './api.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';

// Runtime panel for managing SSH port-forward tunnels on a live connection:
// starting/stopping saved (non-auto-start) rules, and one-off ad-hoc tunnels
// that are never persisted.
export function openPortForwardPanel(connID, sessionID) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.id = 'pf-overlay';
  overlay.innerHTML = `
<div class="modal" style="width:640px;display:flex;flex-direction:column;max-height:80vh;">
  <div class="modal-header">
    <span class="modal-title">${t('portForward.title')}</span>
    <button class="btn btn-ghost btn-icon" id="pf-close">✕</button>
  </div>
  <div class="modal-body" style="flex:1;overflow-y:auto;">
    <div id="pf-panel-list"></div>
    <div class="pf-adhoc">
      <div class="pf-adhoc-title">${t('portForward.adhocTitle')} <span class="pf-adhoc-hint">${t('portForward.adhocHint')}</span></div>
      <div class="pf-adhoc-grid">
        <div class="pf-field pf-field-type">
          <label>${t('profileForm.pfType')}</label>
          <select class="input" id="pf-adhoc-type">
            <option value="local">${t('profileForm.pfLocal')}</option>
            <option value="remote">${t('profileForm.pfRemote')}</option>
            <option value="dynamic">${t('profileForm.pfDynamic')}</option>
          </select>
        </div>
        <div class="pf-field pf-field-port">
          <label>${t('profileForm.pfBindPort')}</label>
          <input class="input" id="pf-adhoc-bindport" type="number" placeholder="8080" />
        </div>
        <div class="pf-field-target" id="pf-adhoc-target">
          <div class="pf-field pf-field-host">
            <label>${t('profileForm.pfTargetHost')}</label>
            <input class="input" id="pf-adhoc-targethost" placeholder="127.0.0.1" />
          </div>
          <div class="pf-field pf-field-port">
            <label>${t('profileForm.pfTargetPort')}</label>
            <input class="input" id="pf-adhoc-targetport" type="number" placeholder="3306" />
          </div>
        </div>
        <button class="btn btn-primary" id="pf-adhoc-start">${t('portForward.start')}</button>
      </div>
    </div>
  </div>
</div>`;
  document.getElementById('modal-root').appendChild(overlay);
  const $ = id => overlay.querySelector('#' + id);
  const close = () => {
    document.removeEventListener('keydown', docEscHandler, true);
    window.removeEventListener('ishell:nativeEsc', nativeEscHandler);
    overlay.remove();
  };
  $('pf-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  // Non-fullscreen: DOM keydown captured before other handlers
  function docEscHandler(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  document.addEventListener('keydown', docEscHandler, true);

  // Fullscreen: native guard consumes ESC and emits this event instead of DOM keydown
  function nativeEscHandler() { close(); }
  window.addEventListener('ishell:nativeEsc', nativeEscHandler);

  $('pf-adhoc-type').addEventListener('change', e => {
    $('pf-adhoc-target').style.display = e.target.value === 'dynamic' ? 'none' : 'flex';
  });

  $('pf-adhoc-start').addEventListener('click', async () => {
    const pf = {
      type: $('pf-adhoc-type').value,
      bind_addr: '127.0.0.1',
      bind_port: parseInt($('pf-adhoc-bindport').value, 10) || 0,
      target_host: $('pf-adhoc-targethost').value.trim(),
      target_port: parseInt($('pf-adhoc-targetport').value, 10) || 0,
      auto_start: false,
      enabled: true,
    };
    if (!pf.bind_port) { showToast(t('portForward.bindPortRequired')); return; }
    try {
      await startAdHocForward(connID, pf);
      showToast(t('portForward.started'));
      refresh();
    } catch (e) {
      showToast('❌ ' + e);
    }
  });

  async function refresh() {
    const list = $('pf-panel-list');
    if (!list) return;
    const [savedRules, active] = await Promise.all([
      sessionID ? listPortForwardsForSession(sessionID).catch(() => []) : Promise.resolve([]),
      listActiveForwards(connID).catch(() => []),
    ]);
    const activeByID = new Map((active || []).map(a => [a.id, a]));
    const rows = (savedRules || []).map(rule => {
      const status = activeByID.get(rule.id);
      activeByID.delete(rule.id);
      return renderRuleRow(rule, status);
    });
    activeByID.forEach(status => rows.push(renderRuleRow(status.rule, status))); // active ad-hoc tunnels
    list.innerHTML = rows.length
      ? `<div class="pf-rule-list">${rows.join('')}</div>`
      : `<div class="pf-empty"><span class="pf-empty-icon">⇄</span>${t('portForward.none')}</div>`;
    list.querySelectorAll('[data-start]').forEach(btn => btn.addEventListener('click', async () => {
      try { await startPortForward(connID, btn.dataset.start); refresh(); } catch (e) { showToast('❌ ' + e); }
    }));
    list.querySelectorAll('[data-stop]').forEach(btn => btn.addEventListener('click', async () => {
      try { await stopPortForward(connID, btn.dataset.stop); refresh(); } catch (e) { showToast('❌ ' + e); }
    }));
  }

  function renderRuleRow(rule, status) {
    const typeLabel = rule.type === 'local' ? t('profileForm.pfLocal') : rule.type === 'remote' ? t('profileForm.pfRemote') : t('profileForm.pfDynamic');
    const desc = rule.type === 'dynamic'
      ? `${rule.bind_addr}:${rule.bind_port} (SOCKS)`
      : `${rule.bind_addr}:${rule.bind_port} → ${rule.target_host}:${rule.target_port}`;
    const active = !!status?.active;
    const isError = !active && !!status?.error;
    const statusLabel = active ? t('portForward.running') : (status?.error ? '❌ ' + esc(status.error) : t('portForward.stopped'));
    const statusClass = active ? 'is-active' : (isError ? 'is-error' : '');
    const actionBtn = active
      ? `<button class="btn btn-danger btn-sm" data-stop="${esc(rule.id)}">${t('portForward.stop')}</button>`
      : (rule.id ? `<button class="btn btn-secondary btn-sm" data-start="${esc(rule.id)}">${t('portForward.start')}</button>` : '');
    return `
      <div class="pf-rule-row">
        <span class="pf-rule-type">${typeLabel}</span>
        <span class="pf-rule-desc">${esc(desc)}</span>
        <span class="pf-rule-status ${statusClass}">${statusLabel}</span>
        ${actionBtn}
      </div>`;
  }

  refresh();
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
