import { getSettings, saveSettings, getKnownHosts, removeKnownHost } from './api.js';
import { showToast } from './toast.js';

export async function initSettings() {
  const panel = document.getElementById('panel-settings');
  const settings = await getSettings().catch(() => ({}));
  const kh = await getKnownHosts().catch(() => []);

  panel.innerHTML = `
<div class="settings-layout">
  <nav class="settings-nav">
    <div class="nav-pill active" data-page="appearance">🎨 Appearance</div>
    <div class="nav-pill" data-page="terminal">⌨ Terminal</div>
    <div class="nav-pill" data-page="ssh">🔐 SSH / Security</div>
    <div class="nav-pill" data-page="shortcuts">⌘ Shortcuts</div>
    <div class="nav-pill" data-page="about">ℹ About</div>
  </nav>
  <div class="settings-content">

    <!-- Appearance -->
    <div class="settings-page active" id="sp-appearance">
      <div class="settings-page-title">Appearance</div>
      <div class="settings-section">
        <div class="settings-section-title">Theme</div>
        <div class="settings-row">
          <div class="settings-row-label">Color theme</div>
          <div class="settings-row-control">
            <select class="input" id="st-theme" style="width:auto;">
              <option value="dark" ${settings.theme==='dark'?'selected':''}>Dark</option>
              <option value="light" ${settings.theme==='light'?'selected':''}>Light</option>
            </select>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Font</div>
        <div class="settings-row">
          <div class="settings-row-label">Font family</div>
          <div class="settings-row-control">
            <select class="input" id="st-font" style="width:auto;">
              ${['Cascadia Code','JetBrains Mono','Fira Code','Consolas','Monaco'].map(f=>`<option ${(settings.font_family||'').includes(f)?'selected':''}>${f}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Font size</div>
          <div class="settings-row-control" style="min-width:180px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <input type="range" id="st-fontsize" min="10" max="24" value="${settings.font_size||13}" style="flex:1;accent-color:var(--accent);" oninput="document.getElementById('st-fontsize-val').textContent=this.value" />
              <span id="st-fontsize-val" style="font-size:12px;width:24px;">${settings.font_size||13}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Terminal -->
    <div class="settings-page" id="sp-terminal">
      <div class="settings-page-title">Terminal</div>
      <div class="settings-section">
        <div class="settings-section-title">Cursor</div>
        <div class="settings-row">
          <div class="settings-row-label">Cursor style</div>
          <div class="settings-row-control">
            <select class="input" id="st-cursor" style="width:auto;">
              ${['block','underline','bar'].map(c=>`<option value="${c}" ${settings.cursor_style===c?'selected':''}>${c}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Blink cursor</div>
          <div class="settings-row-control"><div class="toggle-switch ${settings.cursor_blink!==false?'on':''}" id="st-blink"></div></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Behavior</div>
        <div class="settings-row">
          <div class="settings-row-label">Scrollback lines</div>
          <div class="settings-row-control"><input class="input" id="st-scrollback" type="number" value="${settings.scrollback||10000}" style="width:100px;" /></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Copy on select</div>
          <div class="settings-row-control"><div class="toggle-switch ${settings.copy_on_select?'on':''}" id="st-copysel"></div></div>
        </div>
      </div>
    </div>

    <!-- SSH -->
    <div class="settings-page" id="sp-ssh">
      <div class="settings-page-title">SSH / Security</div>
      <div class="settings-section">
        <div class="settings-section-title">Host Key Verification</div>
        <div class="settings-row">
          <div><div class="settings-row-label">Strict host key checking</div><div class="settings-row-desc">Reject unknown/changed keys</div></div>
          <div class="settings-row-control"><div class="toggle-switch ${settings.strict_host_key!==false?'on':''}" id="st-strict"></div></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">known_hosts path</div>
          <div class="settings-row-control"><input class="input" id="st-khpath" value="${esc(settings.known_hosts_path||'')}" placeholder="~/.ssh/known_hosts" style="width:220px;" /></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Known Hosts</div>
        ${kh.length === 0
          ? '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No known hosts.</div>'
          : kh.map(h => `<div class="settings-row"><div><div class="settings-row-label" style="font-family:var(--font-mono);font-size:12px;">${esc(h.hostname)}</div><div class="settings-row-desc">${esc(h.key_type)} — ${esc(h.fingerprint)}</div></div><button class="btn btn-danger btn-sm" onclick="window._removeKH('${esc(h.hostname)}')">Remove</button></div>`).join('')}
      </div>
    </div>

    <!-- Shortcuts -->
    <div class="settings-page" id="sp-shortcuts">
      <div class="settings-page-title">Keyboard Shortcuts</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:11px;text-transform:uppercase;">Action</th><th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:11px;text-transform:uppercase;">Shortcut</th></tr></thead>
        <tbody>
          ${[
            ['Switch to tab 1–9','Alt+1 … Alt+9'],
            ['Toggle fullscreen','Alt+Enter'],
            ['Toggle sidebar','Ctrl+B'],
            ['New session','Ctrl+N'],
            ['Close tab','Ctrl+W'],
            ['Find in terminal','Ctrl+F'],
          ].map(([a,s])=>`<tr><td style="padding:8px 10px;border-bottom:1px solid var(--border-subtle);">${a}</td><td style="padding:8px 10px;border-bottom:1px solid var(--border-subtle);"><kbd style="padding:2px 7px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:3px;font-family:var(--font-mono);font-size:12px;">${s}</kbd></td></tr>`).join('')}
        </tbody>
      </table>
    </div>

    <!-- About -->
    <div class="settings-page" id="sp-about">
      <div class="settings-page-title">About</div>
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:28px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;">
        <div style="width:64px;height:64px;background:linear-gradient(135deg,var(--accent),var(--mauve));border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:30px;color:#fff;">⌨</div>
        <div style="font-size:22px;font-weight:700;">iShell</div>
        <div style="color:var(--text-muted);">Version 1.0.0</div>
        <div style="font-size:13px;color:var(--text-secondary);max-width:300px;">A modern cross-platform SSH client built with Go and Wails.</div>
      </div>
    </div>

  </div>
</div>`;

  // Nav switching
  panel.querySelectorAll('.nav-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      panel.querySelectorAll('.nav-pill').forEach(p => p.classList.remove('active'));
      panel.querySelectorAll('.settings-page').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      panel.querySelector('#sp-' + pill.dataset.page)?.classList.add('active');
    });
  });

  // Toggle switches
  panel.querySelectorAll('.toggle-switch').forEach(t => {
    t.addEventListener('click', () => t.classList.toggle('on'));
  });

  // Theme apply preview
  document.getElementById('st-theme')?.addEventListener('change', e => {
    document.documentElement.setAttribute('data-theme', e.target.value);
  });

  // Known host removal
  window._removeKH = async (hostname) => {
    if (!confirm(`Remove known host "${hostname}"?`)) return;
    try { await removeKnownHost(hostname); showToast('✅ Removed'); initSettings(); } catch(e) { showToast('❌ ' + e); }
  };

  // Save button (footer)
  const footer = document.createElement('div');
  footer.style.cssText = 'padding:12px 32px;border-top:1px solid var(--border-subtle);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0;';
  footer.innerHTML = `<button class="btn btn-secondary" id="st-discard">Discard</button><button class="btn btn-primary" id="st-save">Save Settings</button>`;
  panel.querySelector('.settings-layout').appendChild(footer);

  document.getElementById('st-discard').addEventListener('click', () => {
    document.getElementById('panel-settings').style.display = 'none';
    document.getElementById('panel-terminal').style.display = '';
  });
  document.getElementById('st-save').addEventListener('click', async () => {
    const updated = {
      ...settings,
      theme: document.getElementById('st-theme')?.value || settings.theme,
      font_family: document.getElementById('st-font')?.value || settings.font_family,
      font_size: parseInt(document.getElementById('st-fontsize')?.value) || settings.font_size,
      cursor_style: document.getElementById('st-cursor')?.value || settings.cursor_style,
      cursor_blink: document.getElementById('st-blink')?.classList.contains('on'),
      scrollback: parseInt(document.getElementById('st-scrollback')?.value) || settings.scrollback,
      copy_on_select: document.getElementById('st-copysel')?.classList.contains('on'),
      strict_host_key: document.getElementById('st-strict')?.classList.contains('on'),
      known_hosts_path: document.getElementById('st-khpath')?.value || '',
    };
    try {
      await saveSettings(updated);
      showToast('✅ Settings saved — restart connections to apply terminal changes');
      document.documentElement.setAttribute('data-theme', updated.theme);
    } catch(e) { showToast('❌ ' + e); }
  });
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
