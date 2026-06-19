import { saveSession, getSessions, openKeyDialog, validateKey } from './api.js';
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
    jump_host: '', jump_profile_id: '', init_command: '',
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
    });
  });

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
    };
    try {
      const saved = await saveSession(updated);
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
