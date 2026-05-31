import { getSettings, saveSettings, getKnownHosts, removeKnownHost } from './api.js';
import { showToast } from './toast.js';

export async function initSettings() {
  const panel = document.getElementById('panel-settings');
  const settings = await getSettings().catch(() => ({}));
  const kh = await getKnownHosts().catch(() => []);
  const fontSize = settings.font_size || 16;

  const isMac = navigator.platform.startsWith('Mac');
  const mod = isMac ? '⌘' : 'Ctrl';
  const alt = isMac ? '⌘' : 'Alt';

  panel.innerHTML = `
<div class="settings-layout">
  <nav class="settings-nav">
    <div class="nav-pill active" data-page="appearance"><span class="nav-pill-icon">🎨</span>Appearance</div>
    <div class="nav-pill" data-page="terminal"><span class="nav-pill-icon">💻</span>Terminal</div>
    <div class="nav-pill" data-page="ssh"><span class="nav-pill-icon">🔒</span>SSH / Security</div>
    <div class="nav-pill" data-page="shortcuts"><span class="nav-pill-icon">⌨️</span>Shortcuts</div>
    <div class="nav-pill" data-page="about"><span class="nav-pill-icon">ℹ️</span>About</div>
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
              ${['Menlo','SF Mono','Monaco','Cascadia Code','JetBrains Mono','Fira Code','Consolas'].map(f=>`<option ${(settings.font_family||'').includes(f)?'selected':''}>${f}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Font size</div>
          <div class="settings-row-control" style="min-width:180px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <input type="range" id="st-fontsize" min="10" max="24" value="${fontSize}" style="flex:1;accent-color:var(--accent);" oninput="document.getElementById('st-fontsize-val').textContent=this.value" />
              <span id="st-fontsize-val" style="font-size:12px;width:24px;">${fontSize}</span>
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
      ${[
        { group: 'Navigation' },
        ['Switch to tab 1–9',      `${alt}+1 … ${alt}+9`],
        ['Toggle sidebar',         isMac ? `${mod}+B` : 'Alt+B'],
        ['Toggle fullscreen',      isMac ? '⌘+Enter' : 'Alt+Enter'],
        ['Open settings',          `${alt}+,`],
        { group: 'Profiles' },
        ['Open profile picker',    `${alt}+O`],
        ['Connect (in search)',    'Enter'],
        { group: 'Terminal' },
        ['Find in terminal',       isMac ? `${mod}+F` : 'Alt+F'],
        ['Close current tab',      isMac ? '⌘+W' : 'Alt+W'],
      ].map(item => {
        if (item.group) return `
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
                      color:var(--text-muted);padding:14px 10px 6px;border-bottom:1px solid var(--border);">
            ${item.group}
          </div>`;
        const [action, shortcut] = item;
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;
                      padding:9px 10px;border-bottom:1px solid var(--border-subtle);font-size:13px;">
            <span style="color:var(--text-primary);">${action}</span>
            <kbd style="padding:2px 8px;background:var(--bg-elevated);border:1px solid var(--border);
                        border-radius:4px;font-family:var(--font-mono);font-size:12px;
                        color:var(--text-secondary);white-space:nowrap;">${shortcut}</kbd>
          </div>`;
      }).join('')}
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
  panel.appendChild(footer);

  document.getElementById('st-discard').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('ishell:closeSettings'));
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
      localStorage.setItem('theme', updated.theme);
      showToast('✅ Settings saved — restart connections to apply terminal changes');
      document.documentElement.setAttribute('data-theme', updated.theme);
    } catch(e) { showToast('❌ ' + e); }
  });
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
