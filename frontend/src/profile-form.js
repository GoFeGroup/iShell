import { saveSession, getSessions, openKeyDialog, validateKey, listPortForwardsForSession, savePortForward, deletePortForward, checkAgentAvailable } from './api.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';

/**
 * Opens the Add/Edit Session modal.
 * @param {Object|null} existing - existing session object (null = new)
 * @param {Function} onSaved - called with the saved session
 */
export function openProfileForm(existing, onSaved) {
  const isNew = !existing;
  const sess = existing || {
    label: '', host: '', port: 22, username: '',
    auth_type: 'password', password: '', key_path: '', passphrase: '',
    group: '', keepalive: 60, timeout: 30, encoding: 'UTF-8',
    jump_host: '', jump_profile_id: '', init_command: '', forward_agent: false,
  };

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
<div class="modal" style="width:500px;display:flex;flex-direction:column;max-height:90vh;">
  <div class="modal-header">
    <span class="modal-title">${isNew ? t('app.newProfile') : t('profileForm.editTitle')}</span>
    <button class="btn btn-ghost btn-icon" id="sf-close">✕</button>
  </div>
  <div class="modal-body" style="flex:1;overflow-y:auto;">
    <!-- Connection -->
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid var(--border-subtle);">${t('profileForm.sectionConnection')}</div>
    <div class="form-field">
      <label class="form-label">${t('profileForm.label')}</label>
      <input class="input" id="sf-label" value="${esc(sess.label)}" placeholder="${t('profileForm.labelPlaceholder')}" />
    </div>
    <div class="grid-2">
      <div class="form-field">
        <label class="form-label">${t('profileForm.host')}</label>
        <input class="input" id="sf-host" value="${esc(sess.host)}" placeholder="192.168.1.1" />
      </div>
      <div class="form-field">
        <label class="form-label">${t('profileForm.port')}</label>
        <input class="input" id="sf-port" type="number" value="${sess.port || 22}" min="1" max="65535" style="width:100%;" />
      </div>
    </div>
    <div class="form-field">
      <label class="form-label">${t('profileForm.username')}</label>
      <input class="input" id="sf-user" value="${esc(sess.username)}" placeholder="root" />
    </div>
    <div class="form-field">
      <label class="form-label">${t('profileForm.group')}</label>
      <input class="input" id="sf-group" value="${esc(sess.group)}" placeholder="Production" />
    </div>

    <!-- Auth -->
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin:4px 0 12px;padding-top:8px;padding-bottom:6px;border-bottom:1px solid var(--border-subtle);">${t('profileForm.sectionAuth')}</div>
    <div class="auth-tabs">
      <button class="auth-tab ${sess.auth_type==='password'?'active':''}" data-auth="password">${t('profileForm.authPassword')}</button>
      <button class="auth-tab ${sess.auth_type==='key'?'active':''}" data-auth="key">${t('profileForm.authKey')}</button>
      <button class="auth-tab ${sess.auth_type==='agent'?'active':''}" data-auth="agent">${t('profileForm.authAgent')}</button>
    </div>

    <div id="auth-password" style="display:${sess.auth_type==='password'?'block':'none'};">
      <div class="form-field">
        <label class="form-label">${t('profileForm.passwordLabel')}</label>
        <div style="position:relative;">
          <input class="input" id="sf-password" type="password" value="${esc(sess.password)}" placeholder="${t('profileForm.passwordPlaceholder')}" style="padding-right:38px;" />
          <button class="btn btn-ghost" id="sf-pw-toggle" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);padding:2px;font-size:14px;">👁</button>
        </div>
      </div>
    </div>

    <div id="auth-key" style="display:${sess.auth_type==='key'?'block':'none'};">
      <div class="form-field">
        <label class="form-label">${t('profileForm.keyFileLabel')}</label>
        <div style="display:flex;gap:6px;">
          <input class="input" id="sf-keypath" value="${esc(sess.key_path)}" placeholder="~/.ssh/id_rsa" style="font-family:var(--font-mono);font-size:12px;" />
          <button class="btn btn-secondary btn-sm" id="sf-browse-key">${t('common.browse')}</button>
        </div>
      </div>
      <div class="form-field">
        <label class="form-label">${t('profileForm.passphraseLabel')} <span style="color:var(--text-muted);font-weight:400;">${t('profileForm.passphraseHint')}</span></label>
        <input class="input" id="sf-passphrase" type="password" value="${esc(sess.passphrase)}" placeholder="${t('profileForm.passphrasePlaceholder')}" />
      </div>
      <div id="sf-key-status" style="font-size:12px;color:var(--text-muted);margin-top:-8px;margin-bottom:10px;"></div>
    </div>

    <div id="auth-agent" style="display:${sess.auth_type==='agent'?'block':'none'};">
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px;color:var(--text-secondary);font-size:13px;">
        ${t('profileForm.agentInfo')}
        <div id="sf-agent-status" style="margin-top:8px;font-size:12px;color:var(--text-muted);">${t('profileForm.agentChecking')}</div>
      </div>
      <div class="form-field" style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;">
        <label class="form-label" style="margin:0;">${t('profileForm.forwardAgent')}</label>
        <div class="toggle-switch ${sess.forward_agent?'on':''}" id="sf-forward-agent"></div>
      </div>
    </div>

    <!-- Advanced -->
    <div class="adv-section">
      <div class="adv-header" id="sf-adv-toggle">
        <span>${t('profileForm.advancedOptions')}</span><span id="sf-adv-arrow">▶</span>
      </div>
      <div class="adv-body" id="sf-adv-body">
        <div class="grid-2">
          <div class="form-field"><label class="form-label">${t('profileForm.timeout')}</label><input class="input" id="sf-timeout" type="number" value="${sess.timeout||30}" /></div>
          <div class="form-field"><label class="form-label">${t('profileForm.keepalive')}</label><input class="input" id="sf-keepalive" type="number" value="${sess.keepalive||60}" /></div>
        </div>
        <div class="form-field">
          <label class="form-label">${t('profileForm.encoding')}</label>
          <select class="input" id="sf-encoding">
            ${['UTF-8','GBK','ISO-8859-1','Shift-JIS'].map(e=>`<option value="${e}" ${sess.encoding===e?'selected':''}>${e}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label class="form-label">${t('profileForm.jumpHost')}</label>
          <select class="input" id="sf-jump-profile">
            <option value="">${t('profileForm.jumpHostNone')}</option>
          </select>
        </div>
        <div class="form-field"><label class="form-label">${t('profileForm.initCommand')}</label><input class="input" id="sf-init" value="${esc(sess.init_command)}" placeholder="tmux attach" /></div>
        <div class="form-field">
          <label class="form-label">${t('profileForm.pfTitle')}</label>
          ${isNew ? `<div style="font-size:12px;color:var(--text-muted);">${t('profileForm.pfNewProfileHint')}</div>` : `
            <div id="sf-pf-list"></div>
            <button class="btn btn-secondary btn-sm" id="sf-pf-add" type="button" style="margin-top:6px;">${t('profileForm.pfAdd')}</button>
          `}
        </div>
      </div>
    </div>
    <div id="sf-err" style="color:var(--red);font-size:12px;margin-top:10px;display:none;"></div>
  </div>
  <div class="modal-footer">
    <button class="btn btn-secondary" id="sf-cancel">${t('common.cancel')}</button>
    <button class="btn btn-primary" id="sf-save">${t('profileForm.saveProfile')}</button>
  </div>
</div>`;

  document.getElementById('modal-root').appendChild(overlay);

  const $ = (id) => overlay.querySelector('#' + id);

  // Auth tab switching
  overlay.querySelectorAll('.auth-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.auth;
      $('auth-password').style.display = mode === 'password' ? '' : 'none';
      $('auth-key').style.display = mode === 'key' ? '' : 'none';
      $('auth-agent').style.display = mode === 'agent' ? '' : 'none';
      if (mode === 'agent') checkAgentStatus();
    });
  });

  $('sf-forward-agent').addEventListener('click', () => {
    $('sf-forward-agent').classList.toggle('on');
  });

  function checkAgentStatus() {
    const statusEl = $('sf-agent-status');
    if (!statusEl) return;
    statusEl.textContent = t('profileForm.agentChecking');
    checkAgentAvailable().then(ok => {
      statusEl.textContent = ok ? t('profileForm.agentDetected') : t('profileForm.agentNotDetected');
      statusEl.style.color = ok ? 'var(--green)' : 'var(--red)';
    }).catch(() => {
      statusEl.textContent = t('profileForm.agentNotDetected');
      statusEl.style.color = 'var(--red)';
    });
  }
  if (sess.auth_type === 'agent') checkAgentStatus();

  // Password toggle
  $('sf-pw-toggle').addEventListener('click', () => {
    const inp = $('sf-password');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // Browse key
  $('sf-browse-key').addEventListener('click', async () => {
    const path = await openKeyDialog().catch(() => '');
    if (path) $('sf-keypath').value = path;
  });

  // Auto-validate key when path changes
  $('sf-keypath').addEventListener('change', async () => {
    const path = $('sf-keypath').value.trim();
    if (!path) return;
    const statusEl = $('sf-key-status');
    statusEl.textContent = t('profileForm.keyChecking');
    statusEl.style.color = 'var(--text-muted)';
    try {
      const ok = await validateKey(path, $('sf-passphrase').value);
      statusEl.textContent = ok ? t('profileForm.keyValid') : t('profileForm.keyInvalid');
      statusEl.style.color = ok ? 'var(--green)' : 'var(--red)';
    } catch {
      statusEl.textContent = t('profileForm.keyUnreadable');
      statusEl.style.color = 'var(--red)';
    }
  });

  // Populate jump profile dropdown
  getSessions().then(sessions => {
    const sel = $('sf-jump-profile');
    (sessions || []).forEach(s => {
      if (s.id === sess.id) return; // exclude self
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label ? `${s.label} (${s.username}@${s.host})` : `${s.username}@${s.host}`;
      if (s.id === sess.jump_profile_id) opt.selected = true;
      sel.appendChild(opt);
    });
  }).catch(() => {});

  // Port forwarding rules (existing profiles only — a new profile has no ID yet)
  let forwardRules = [];
  const deletedForwardIDs = [];
  if (!isNew) {
    listPortForwardsForSession(sess.id).then(rules => {
      forwardRules = rules || [];
      renderForwardRules();
    }).catch(() => {});

    $('sf-pf-add').addEventListener('click', () => {
      forwardRules.push({ id: '', session_id: sess.id, type: 'local', bind_addr: '127.0.0.1', bind_port: 0, target_host: '', target_port: 0, auto_start: false, enabled: true });
      renderForwardRules();
    });
  }

  function renderForwardRules() {
    const list = $('sf-pf-list');
    if (!list) return;
    if (forwardRules.length === 0) {
      list.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">${t('profileForm.pfEmpty')}</div>`;
      return;
    }
    list.innerHTML = forwardRules.map((r, i) => `
      <div class="pf-rule" data-idx="${i}" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">
        <select class="input pf-type" style="width:auto;">
          <option value="local" ${r.type==='local'?'selected':''}>${t('profileForm.pfLocal')}</option>
          <option value="remote" ${r.type==='remote'?'selected':''}>${t('profileForm.pfRemote')}</option>
          <option value="dynamic" ${r.type==='dynamic'?'selected':''}>${t('profileForm.pfDynamic')}</option>
        </select>
        <input class="input pf-bindaddr" value="${esc(r.bind_addr||'127.0.0.1')}" style="width:110px;" placeholder="${t('profileForm.pfBindAddr')}" />
        <input class="input pf-bindport" type="number" value="${r.bind_port||''}" style="width:80px;" placeholder="${t('profileForm.pfBindPort')}" />
        <span class="pf-target-fields" style="display:${r.type==='dynamic'?'none':'flex'};gap:6px;">
          <input class="input pf-targethost" value="${esc(r.target_host||'')}" style="width:130px;" placeholder="${t('profileForm.pfTargetHost')}" />
          <input class="input pf-targetport" type="number" value="${r.target_port||''}" style="width:80px;" placeholder="${t('profileForm.pfTargetPort')}" />
        </span>
        <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-muted);">
          <input type="checkbox" class="pf-autostart" ${r.auto_start?'checked':''} /> ${t('profileForm.pfAutoStart')}
        </label>
        <button class="btn btn-ghost btn-icon btn-sm pf-remove" type="button">🗑</button>
      </div>`).join('');

    list.querySelectorAll('.pf-rule').forEach(row => {
      const idx = parseInt(row.dataset.idx, 10);
      row.querySelector('.pf-type').addEventListener('change', e => {
        forwardRules[idx].type = e.target.value;
        row.querySelector('.pf-target-fields').style.display = e.target.value === 'dynamic' ? 'none' : 'flex';
      });
      row.querySelector('.pf-bindaddr').addEventListener('input', e => { forwardRules[idx].bind_addr = e.target.value; });
      row.querySelector('.pf-bindport').addEventListener('input', e => { forwardRules[idx].bind_port = parseInt(e.target.value, 10) || 0; });
      row.querySelector('.pf-targethost').addEventListener('input', e => { forwardRules[idx].target_host = e.target.value; });
      row.querySelector('.pf-targetport').addEventListener('input', e => { forwardRules[idx].target_port = parseInt(e.target.value, 10) || 0; });
      row.querySelector('.pf-autostart').addEventListener('change', e => { forwardRules[idx].auto_start = e.target.checked; });
      row.querySelector('.pf-remove').addEventListener('click', () => {
        const [removed] = forwardRules.splice(idx, 1);
        if (removed?.id) deletedForwardIDs.push(removed.id);
        renderForwardRules();
      });
    });
  }

  // Advanced toggle
  $('sf-adv-toggle').addEventListener('click', () => {
    const body = $('sf-adv-body');
    const arrow = $('sf-adv-arrow');
    body.classList.toggle('open');
    arrow.textContent = body.classList.contains('open') ? '▼' : '▶';
  });

  // Close
  const close = () => overlay.remove();
  $('sf-close').addEventListener('click', close);
  $('sf-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  // Save
  $('sf-save').addEventListener('click', async () => {
    const host = $('sf-host').value.trim();
    const user = $('sf-user').value.trim();
    if (!host || !user) {
      $('sf-err').textContent = t('profileForm.errRequired');
      $('sf-err').style.display = '';
      return;
    }
    const authMode = overlay.querySelector('.auth-tab.active')?.dataset.auth || 'password';
    const updated = {
      ...sess,
      label: $('sf-label').value.trim(),
      host,
      port: parseInt($('sf-port').value) || 22,
      username: user,
      auth_type: authMode,
      password: authMode === 'password' ? $('sf-password').value : '',
      key_path: authMode === 'key' ? $('sf-keypath').value.trim() : '',
      passphrase: authMode === 'key' ? $('sf-passphrase').value : '',
      group: $('sf-group').value.trim(),
      timeout: parseInt($('sf-timeout').value) || 30,
      keepalive: parseInt($('sf-keepalive').value) || 60,
      encoding: $('sf-encoding').value,
      jump_host: '',
      jump_profile_id: $('sf-jump-profile').value,
      init_command: $('sf-init').value.trim(),
      forward_agent: $('sf-forward-agent').classList.contains('on'),
    };
    try {
      const saved = await saveSession(updated);
      await Promise.all([
        ...forwardRules.map(r => savePortForward({ ...r, session_id: saved.id })),
        ...deletedForwardIDs.map(id => deletePortForward(id)),
      ]);
      close();
      onSaved(saved);
      showToast(t('toast.profileSaved', { name: saved.label || saved.host }));
    } catch (e) {
      $('sf-err').textContent = '❌ ' + (e.message || String(e));
      $('sf-err').style.display = '';
    }
  });
}

function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}
