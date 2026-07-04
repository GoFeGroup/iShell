import { getSettings, saveSettings, getKnownHosts, removeKnownHost, exportConfig, importConfig, listBuiltinToolCalls, getVersion } from './api.js';
import { showToast } from './toast.js';
import { shortcutLabelForIndex } from './quick-command.js';
import { loadProfiles } from './sidebar.js';
import { t, setLanguage, getLanguagePref, LANGUAGE_OPTIONS } from './i18n.js';
import { confirmDialog } from './confirm-dialog.js';

export async function initSettings(initialPage = 'appearance') {
  const panel = document.getElementById('panel-settings');
  const settings = await getSettings().catch(() => ({}));
  const kh = await getKnownHosts().catch(() => []);
  const builtinToolCalls = await listBuiltinToolCalls().catch(() => []);
  const appVersion = await getVersion().catch(() => 'dev');
  const fontSize = settings.font_size || 16;
  const languagePref = getLanguagePref();
  let quickCommandGroups = normalizeQuickCommandGroups(settings);
  let customToolCalls = normalizeCustomToolCalls(settings.custom_tool_calls);
  // IDs/hostnames currently armed for delete (showing inline Delete/Cancel
  // in place of their normal actions) — at most one per list at a time.
  // Mirrors ai-sidebar.js's inline-confirm pattern instead of
  // window.confirm(), which this app's webview does not reliably support.
  let confirmingToolDeleteID = null;
  let confirmingGroupDeleteID = null;
  let confirmingHostname = null;

  // Live, mutable view of the persisted settings. Every control updates this
  // object and immediately persists it — there is no separate Save/Discard
  // step, so what's on screen always matches what's stored.
  const current = { ...settings, language: languagePref };
  const webSearchEngines = [
    { value: 'duckduckgo', label: 'DuckDuckGo' },
    { value: 'searxng', label: 'SearXNG' },
    { value: 'brave', label: 'Brave Search' },
    { value: 'serpapi', label: 'SerpAPI Google' },
    { value: 'bing', label: 'Bing Web Search' },
    { value: 'custom', label: t('settings.ai.webSearchCustom') },
  ];

  const isMac = navigator.platform.startsWith('Mac');
  const mod = isMac ? '⌘' : 'Ctrl';
  const alt = isMac ? '⌘' : 'Alt';

  panel.innerHTML = `
<div class="settings-layout">
  <nav class="settings-nav">
    <div class="nav-pill active" data-page="appearance"><span class="nav-pill-icon">🎨</span>${t('settings.nav.appearance')}</div>
    <div class="nav-pill" data-page="terminal"><span class="nav-pill-icon">💻</span>${t('settings.nav.terminal')}</div>
    <div class="nav-pill" data-page="ssh"><span class="nav-pill-icon">🔒</span>${t('settings.nav.ssh')}</div>
    <div class="nav-pill" data-page="quick-commands"><span class="nav-pill-icon">⚡</span>${t('settings.nav.quickCommands')}</div>
    <div class="nav-pill" data-page="ai"><span class="nav-pill-icon">✨</span>${t('settings.nav.ai')}</div>
    <div class="nav-pill" data-page="tool-calls"><span class="nav-pill-icon">🔧</span>${t('settings.nav.toolCalls')}</div>
    <div class="nav-pill" data-page="backup"><span class="nav-pill-icon">💾</span>${t('settings.nav.backup')}</div>
    <div class="nav-pill" data-page="shortcuts"><span class="nav-pill-icon">⌨️</span>${t('settings.nav.shortcuts')}</div>
    <div class="nav-pill" data-page="about"><span class="nav-pill-icon">ℹ️</span>${t('settings.nav.about')}</div>
  </nav>
  <div class="settings-content">

    <!-- Appearance -->
    <div class="settings-page active" id="sp-appearance">
      <div class="settings-page-title">${t('settings.nav.appearance')}</div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.appearance.theme')}</div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.appearance.colorTheme')}</div>
          <div class="settings-row-control">
            <select class="input" id="st-theme" style="width:auto;">
              <option value="dark" ${settings.theme==='dark'?'selected':''}>${t('settings.appearance.dark')}</option>
              <option value="light" ${settings.theme==='light'?'selected':''}>${t('settings.appearance.light')}</option>
            </select>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.appearance.font')}</div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.appearance.fontFamily')}</div>
          <div class="settings-row-control">
            <select class="input" id="st-font" style="width:auto;">
              ${['Menlo','SF Mono','Monaco','Cascadia Code','JetBrains Mono','Fira Code','Consolas'].map(f=>`<option ${(settings.font_family||'').includes(f)?'selected':''}>${f}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.appearance.fontSize')}</div>
          <div class="settings-row-control" style="min-width:180px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <input type="range" id="st-fontsize" min="10" max="24" value="${fontSize}" style="flex:1;accent-color:var(--accent);" oninput="document.getElementById('st-fontsize-val').textContent=this.value" />
              <span id="st-fontsize-val" style="font-size:12px;width:24px;">${fontSize}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.appearance.language')}</div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.appearance.interfaceLanguage')}</div>
          <div class="settings-row-control">
            <select class="input" id="st-language" style="width:auto;">
              ${LANGUAGE_OPTIONS.map(o=>`<option value="${o.value}" ${languagePref===o.value?'selected':''}>${t(o.labelKey)}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- Terminal -->
    <div class="settings-page" id="sp-terminal">
      <div class="settings-page-title">${t('settings.nav.terminal')}</div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.terminal.cursor')}</div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.terminal.cursorStyle')}</div>
          <div class="settings-row-control">
            <select class="input" id="st-cursor" style="width:auto;">
              ${['block','underline','bar'].map(c=>`<option value="${c}" ${settings.cursor_style===c?'selected':''}>${c}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.terminal.blinkCursor')}</div>
          <div class="settings-row-control"><div class="toggle-switch ${settings.cursor_blink!==false?'on':''}" id="st-blink"></div></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.terminal.behavior')}</div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.terminal.scrollbackLines')}</div>
          <div class="settings-row-control"><input class="input" id="st-scrollback" type="number" value="${settings.scrollback||10000}" style="width:100px;" /></div>
        </div>
      </div>
    </div>

    <!-- SSH -->
    <div class="settings-page" id="sp-ssh">
      <div class="settings-page-title">${t('settings.nav.ssh')}</div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.ssh.hostKeyVerification')}</div>
        <div class="settings-row">
          <div><div class="settings-row-label">${t('settings.ssh.strictHostKey')}</div><div class="settings-row-desc">${t('settings.ssh.strictHostKeyDesc')}</div></div>
          <div class="settings-row-control"><div class="toggle-switch ${settings.strict_host_key!==false?'on':''}" id="st-strict"></div></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.ssh.knownHostsPath')}</div>
          <div class="settings-row-control"><input class="input" id="st-khpath" value="${esc(settings.known_hosts_path||'')}" placeholder="~/.ssh/known_hosts" style="width:220px;" /></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.ssh.knownHosts')}</div>
        <div id="kh-list"></div>
      </div>
    </div>

    <!-- AI -->
    <div class="settings-page" id="sp-ai">
      <div class="settings-page-title">${t('settings.nav.ai')}</div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.ai.provider')}</div>
        <div class="settings-row">
          <div><div class="settings-row-label">${t('settings.ai.enabled')}</div><div class="settings-row-desc">${t('settings.ai.enabledDesc')}</div></div>
          <div class="settings-row-control"><div class="toggle-switch ${settings.ai_enabled?'on':''}" id="st-ai-enabled"></div></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.ai.apiKey')}</div>
          <div class="settings-row-control"><input class="input" id="st-ai-key" type="password" autocomplete="off" value="${esc(settings.ai_api_key||'')}" placeholder="${t('settings.ai.apiKeyPlaceholder')}" style="width:240px;" /></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.ai.baseUrl')}</div>
          <div class="settings-row-control"><input class="input" id="st-ai-baseurl" value="${esc(settings.ai_base_url||'')}" placeholder="${t('settings.ai.baseUrlPlaceholder')}" style="width:240px;" /></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.ai.model')}</div>
          <div class="settings-row-control"><input class="input" id="st-ai-model" value="${esc(settings.ai_model||'')}" placeholder="${t('settings.ai.modelPlaceholder')}" style="width:240px;" /></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.ai.webSearch')}</div>
        <div class="settings-row">
          <div><div class="settings-row-label">${t('settings.ai.webSearchEngine')}</div><div class="settings-row-desc">${t('settings.ai.webSearchDesc')}</div></div>
          <div class="settings-row-control">
            <select class="input" id="st-ai-websearch-engine" style="width:240px;">
              ${webSearchEngines.map(e=>`<option value="${e.value}" ${(settings.ai_web_search_engine||'duckduckgo')===e.value?'selected':''}>${e.label}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.ai.webSearchEndpoint')}</div>
          <div class="settings-row-control"><input class="input" id="st-ai-websearch-endpoint" value="${esc(settings.ai_web_search_endpoint||defaultWebSearchEndpoint(settings.ai_web_search_engine||'duckduckgo'))}" placeholder="${t('settings.ai.webSearchEndpointPlaceholder')}" style="width:320px;" /></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">${t('settings.ai.webSearchAPIKey')}</div>
          <div class="settings-row-control"><input class="input" id="st-ai-websearch-key" type="password" autocomplete="off" value="${esc(settings.ai_web_search_api_key||'')}" placeholder="${t('settings.ai.webSearchAPIKeyPlaceholder')}" style="width:240px;" /></div>
        </div>
      </div>
    </div>

    <!-- Tool Calls -->
    <div class="settings-page" id="sp-tool-calls">
      <div class="settings-page-title">${t('settings.nav.toolCalls')}</div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.toolCalls.builtinTitle')}</div>
        <div class="settings-row-desc" style="margin-bottom:10px;">${t('settings.toolCalls.builtinDesc')}</div>
        ${builtinToolCalls.length === 0
          ? ''
          : builtinToolCalls.map(tool => `
            <div class="tc-builtin-row">
              <div class="tc-builtin-name">${esc(tool.name)} <span class="tc-builtin-badge">${t('settings.toolCalls.builtinBadge')}</span></div>
              <div class="tc-builtin-desc">${esc(tool.description)}</div>
            </div>`).join('')}
      </div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.toolCalls.customTitle')}</div>
        <div class="settings-row-desc" style="margin-bottom:10px;">${t('settings.toolCalls.templateHelp')}</div>
        <div id="tc-editor"></div>
        <button class="btn btn-secondary btn-sm" id="tc-add" type="button">${t('settings.toolCalls.addToolCall')}</button>
      </div>
    </div>

    <!-- Import / Export -->
    <div class="settings-page" id="sp-backup">
      <div class="settings-page-title">${t('settings.nav.backup')}</div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.backup.title')}</div>
        <div class="settings-row-desc" style="margin-bottom:10px;">${t('settings.backup.warning')}</div>
        <div class="settings-row">
          <div><div class="settings-row-label">${t('settings.backup.exportLabel')}</div><div class="settings-row-desc">${t('settings.backup.exportDesc')}</div></div>
          <div class="settings-row-control"><button class="btn btn-secondary btn-sm" id="st-export-config" type="button">${t('settings.backup.exportBtn')}</button></div>
        </div>
        <div class="settings-row">
          <div><div class="settings-row-label">${t('settings.backup.importLabel')}</div><div class="settings-row-desc">${t('settings.backup.importDesc')}</div></div>
          <div class="settings-row-control"><button class="btn btn-secondary btn-sm" id="st-import-config" type="button">${t('settings.backup.importBtn')}</button></div>
        </div>
      </div>
    </div>

    <!-- Quick Commands -->
    <div class="settings-page" id="sp-quick-commands">
      <div class="settings-page-title">${t('settings.nav.quickCommands')}</div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.quickCommands.display')}</div>
        <div class="settings-row">
          <div><div class="settings-row-label">${t('settings.quickCommands.showBar')}</div><div class="settings-row-desc">${t('settings.quickCommands.showBarDesc')}</div></div>
          <div class="settings-row-control"><div class="toggle-switch ${settings.show_quick_commands!==false?'on':''}" id="st-show-qc"></div></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">${t('settings.quickCommands.groups')}</div>
        <div class="settings-row-desc">${t('settings.quickCommands.escapeHelp')}</div>
        <div id="qc-editor"></div>
        <button class="btn btn-secondary btn-sm" id="qc-add-group" type="button">${t('settings.quickCommands.addGroup')}</button>
      </div>
    </div>

    <!-- Shortcuts -->
    <div class="settings-page" id="sp-shortcuts">
      <div class="settings-page-title">${t('settings.shortcuts.title')}</div>
      ${[
        { group: t('settings.shortcuts.groupNavigation') },
        [t('settings.shortcuts.switchTab'),      `${alt}+1 … ${alt}+9`],
        [t('settings.shortcuts.toggleSidebar'),  isMac ? `${mod}+B` : 'Alt+B'],
        [t('settings.shortcuts.toggleAI'),       'Alt+Shift+A'],
        [t('settings.shortcuts.toggleFullscreen'), isMac ? '⌘+Enter' : 'Alt+Enter'],
        [t('settings.shortcuts.openSettings'),   `${alt}+,`],
        { group: t('settings.shortcuts.groupProfiles') },
        [t('settings.shortcuts.openProfilePicker'), `${alt}+O`],
        [t('settings.shortcuts.connectInSearch'), 'Enter'],
        { group: t('settings.shortcuts.groupTerminal') },
        [t('settings.shortcuts.openLocalTerminal'), isMac ? '⌘+T' : 'Alt+T'],
        [t('settings.shortcuts.findInTerminal'), isMac ? `${mod}+F` : 'Alt+F'],
        [t('settings.shortcuts.closeTab'),       isMac ? '⌘+W' : 'Alt+W'],
        [t('settings.shortcuts.runQuickCommand'), 'Ctrl+1 … Ctrl+9'],
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
      <div class="settings-page-title">${t('settings.nav.about')}</div>
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:28px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;">
        <div style="width:64px;height:64px;background:linear-gradient(135deg,var(--accent),var(--mauve));border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:30px;color:#fff;">⌨</div>
        <div style="font-size:22px;font-weight:700;">iShell</div>
        <div style="color:var(--text-muted);">${t('settings.about.versionLabel')} 1.0.0</div>
        <div style="font-size:13px;color:var(--text-secondary);max-width:300px;">${t('settings.about.description')}</div>
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
  activatePage(initialPage);

  // ── Live persistence ──────────────────────────────────────────────────────
  // Every control below updates `current` and persists it immediately —
  // there is no Save/Discard step.
  async function persist() {
    try {
      await saveSettings(current);
      window.dispatchEvent(new CustomEvent('ishell:settingsSaved', { detail: { settings: current } }));
    } catch (e) {
      showToast('❌ ' + e);
    }
  }
  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }
  const persistDebounced = debounce(persist, 500);

  document.getElementById('st-theme')?.addEventListener('change', e => {
    current.theme = e.target.value;
    document.documentElement.setAttribute('data-theme', current.theme);
    localStorage.setItem('theme', current.theme);
    persist();
  });
  document.getElementById('st-font')?.addEventListener('change', e => {
    current.font_family = e.target.value;
    persist();
  });
  document.getElementById('st-fontsize')?.addEventListener('change', e => {
    current.font_size = parseInt(e.target.value) || current.font_size;
    persist();
  });
  document.getElementById('st-language')?.addEventListener('change', async e => {
    const newPref = e.target.value;
    current.language = newPref;
    setLanguage(newPref);
    await persist();
    initSettings(panel.querySelector('.nav-pill.active')?.dataset.page || 'appearance');
  });
  document.getElementById('st-cursor')?.addEventListener('change', e => {
    current.cursor_style = e.target.value;
    persist();
  });
  bindToggle('st-blink', on => { current.cursor_blink = on; persist(); });
  document.getElementById('st-scrollback')?.addEventListener('change', e => {
    current.scrollback = parseInt(e.target.value) || current.scrollback;
    persist();
  });
  bindToggle('st-strict', on => { current.strict_host_key = on; persist(); });
  document.getElementById('st-khpath')?.addEventListener('input', e => {
    current.known_hosts_path = e.target.value || '';
    persistDebounced();
  });
  bindToggle('st-show-qc', on => { current.show_quick_commands = on; persist(); });
  bindToggle('st-ai-enabled', on => { current.ai_enabled = on; persist(); });
  document.getElementById('st-ai-key')?.addEventListener('input', e => {
    current.ai_api_key = e.target.value; persistDebounced();
  });
  document.getElementById('st-ai-baseurl')?.addEventListener('input', e => {
    current.ai_base_url = e.target.value; persistDebounced();
  });
  document.getElementById('st-ai-model')?.addEventListener('input', e => {
    current.ai_model = e.target.value; persistDebounced();
  });
  document.getElementById('st-ai-websearch-engine')?.addEventListener('change', e => {
    current.ai_web_search_engine = e.target.value;
    current.ai_web_search_endpoint = defaultWebSearchEndpoint(current.ai_web_search_engine);
    const endpointEl = document.getElementById('st-ai-websearch-endpoint');
    if (endpointEl) endpointEl.value = current.ai_web_search_endpoint;
    persist();
  });
  document.getElementById('st-ai-websearch-endpoint')?.addEventListener('input', e => {
    current.ai_web_search_endpoint = e.target.value; persistDebounced();
  });
  document.getElementById('st-ai-websearch-key')?.addEventListener('input', e => {
    current.ai_web_search_api_key = e.target.value; persistDebounced();
  });

  function bindToggle(id, onChange) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', () => {
      el.classList.toggle('on');
      onChange(el.classList.contains('on'));
    });
  }

  function persistQuickCommands() {
    current.quick_command_groups = collectQuickCommandGroups();
    current.quick_commands = [];
    persist();
  }

  renderGroupsEditor();
  document.getElementById('qc-add-group')?.addEventListener('click', () => {
    collectQuickCommandGroups({ keepBlank: true });
    quickCommandGroups.push({ id: makeGroupID(), name: t('settings.quickCommands.newGroupName'), commands: [] });
    renderGroupsEditor();
    persistQuickCommands();
  });

  function persistCustomToolCalls() {
    current.custom_tool_calls = collectCustomToolCalls();
    persist();
  }

  renderToolCallsEditor();
  document.getElementById('tc-add')?.addEventListener('click', () => {
    collectCustomToolCalls({ keepBlank: true });
    customToolCalls.push({ id: makeToolID(), name: '', description: '', command_template: '', parameters: [], enabled: true });
    renderToolCallsEditor();
  });

  renderKnownHostsList();

  // Config export / import
  document.getElementById('st-export-config')?.addEventListener('click', async () => {
    try {
      const path = await exportConfig();
      if (path) showToast(t('toast.exported', { path }));
    } catch (e) { showToast('❌ ' + e); }
  });
  document.getElementById('st-import-config')?.addEventListener('click', async () => {
    if (!(await confirmDialog(t('settings.backup.confirmImport')))) return;
    try {
      const result = await importConfig();
      if (!result) return; // user cancelled the file picker
      showToast(t('toast.imported', { n: result.session_count }));
      await loadProfiles();
      const fresh = await getSettings().catch(() => null);
      if (fresh) {
        localStorage.setItem('theme', fresh.theme);
        document.documentElement.setAttribute('data-theme', fresh.theme);
        if (fresh.language) setLanguage(fresh.language);
        window.dispatchEvent(new CustomEvent('ishell:settingsSaved', { detail: { settings: fresh } }));
      }
      initSettings('backup');
    } catch (e) { showToast('❌ ' + e); }
  });

  function activatePage(page) {
    const safePage = panel.querySelector('#sp-' + page) ? page : 'appearance';
    panel.querySelectorAll('.nav-pill').forEach(p => p.classList.toggle('active', p.dataset.page === safePage));
    panel.querySelectorAll('.settings-page').forEach(p => p.classList.remove('active'));
    panel.querySelector('#sp-' + safePage)?.classList.add('active');
  }

  function renderGroupsEditor() {
    const editor = document.getElementById('qc-editor');
    if (!editor) return;
    if (quickCommandGroups.length === 0) {
      editor.innerHTML = `<div class="qc-empty" style="margin-bottom:8px;">${t('settings.quickCommands.noGroups')}</div>`;
      return;
    }
    editor.innerHTML = quickCommandGroups.map((group, gi) => `
      <div class="qc-group" data-group-id="${esc(group.id)}">
        <div class="qc-group-header">
          <input class="input qc-group-name" value="${esc(group.name)}" placeholder="${t('settings.quickCommands.groupNamePlaceholder')}" />
          <div class="qc-group-header-actions${confirmingGroupDeleteID === group.id ? ' confirming' : ''}">
            ${confirmingGroupDeleteID === group.id ? `
              <span class="ai-confirm-label">${t('settings.quickCommands.confirmDeleteGroup')}</span>
              <button class="btn btn-danger btn-sm qc-group-confirm-delete" type="button">${t('common.delete')}</button>
              <button class="btn btn-ghost btn-sm qc-group-cancel-delete" type="button">${t('common.cancel')}</button>
            ` : `
              <button class="btn btn-ghost btn-icon btn-sm qc-group-up" type="button" title="${t('settings.quickCommands.moveGroupUp')}" ${gi === 0 ? 'disabled' : ''}>▲</button>
              <button class="btn btn-ghost btn-icon btn-sm qc-group-down" type="button" title="${t('settings.quickCommands.moveGroupDown')}" ${gi === quickCommandGroups.length - 1 ? 'disabled' : ''}>▼</button>
              <button class="btn btn-danger btn-icon btn-sm qc-group-delete" type="button" title="${t('settings.quickCommands.deleteGroup')}">✕</button>
            `}
          </div>
        </div>
        <div class="qc-group-commands">
          ${group.commands.length === 0
            ? `<div class="qc-empty">${t('settings.quickCommands.noCommands')}</div>`
            : group.commands.map((cmd, ci) => `
              <div class="qc-row" data-id="${esc(cmd.id)}">
                <div class="qc-row-fields">
                  <input class="input qc-label" value="${esc(cmd.label)}" placeholder="${t('settings.quickCommands.labelPlaceholder')}" />
                  <textarea class="input qc-command" rows="1" wrap="off" placeholder="${t('settings.quickCommands.commandPlaceholder')}">${escText(cmd.command)}</textarea>
                </div>
                ${ci < 9 ? `<div class="qc-row-shortcut" title="${t('settings.quickCommands.builtinShortcut')}">${esc(shortcutLabelForIndex(ci))}</div>` : ''}
                <div class="qc-row-actions">
                  <button class="btn btn-ghost btn-icon btn-sm qc-up" type="button" title="${t('common.moveUp')}" ${ci === 0 ? 'disabled' : ''}>▲</button>
                  <button class="btn btn-ghost btn-icon btn-sm qc-down" type="button" title="${t('common.moveDown')}" ${ci === group.commands.length - 1 ? 'disabled' : ''}>▼</button>
                  <button class="btn btn-danger btn-icon btn-sm qc-delete" type="button" title="${t('common.delete')}">✕</button>
                </div>
              </div>`).join('')}
        </div>
        <div class="qc-group-footer">
          <button class="btn btn-secondary btn-sm qc-add-cmd" type="button">${t('settings.quickCommands.addCommand')}</button>
        </div>
      </div>
    `).join('');

    editor.querySelectorAll('.qc-group').forEach(groupEl => {
      const groupId = groupEl.dataset.groupId;

      groupEl.querySelector('.qc-group-up')?.addEventListener('click', () => moveGroup(groupId, -1));
      groupEl.querySelector('.qc-group-down')?.addEventListener('click', () => moveGroup(groupId, 1));
      groupEl.querySelector('.qc-group-delete')?.addEventListener('click', () => {
        collectQuickCommandGroups({ keepBlank: true });
        confirmingGroupDeleteID = groupId;
        renderGroupsEditor();
      });
      groupEl.querySelector('.qc-group-confirm-delete')?.addEventListener('click', () => {
        collectQuickCommandGroups({ keepBlank: true });
        confirmingGroupDeleteID = null;
        quickCommandGroups = quickCommandGroups.filter(g => g.id !== groupId);
        renderGroupsEditor();
        persistQuickCommands();
      });
      groupEl.querySelector('.qc-group-cancel-delete')?.addEventListener('click', () => {
        confirmingGroupDeleteID = null;
        renderGroupsEditor();
      });
      groupEl.querySelector('.qc-add-cmd')?.addEventListener('click', () => {
        collectQuickCommandGroups({ keepBlank: true });
        const g = quickCommandGroups.find(g => g.id === groupId);
        if (g) g.commands.push({ id: makeID(), label: '', command: '' });
        renderGroupsEditor();
      });
      groupEl.querySelector('.qc-group-name')?.addEventListener('blur', () => persistQuickCommands());
      groupEl.querySelectorAll('.qc-row').forEach(row => {
        row.querySelector('.qc-up')?.addEventListener('click', () => moveCommandInGroup(groupId, row.dataset.id, -1));
        row.querySelector('.qc-down')?.addEventListener('click', () => moveCommandInGroup(groupId, row.dataset.id, 1));
        row.querySelector('.qc-delete')?.addEventListener('click', () => {
          collectQuickCommandGroups({ keepBlank: true });
          const g = quickCommandGroups.find(g => g.id === groupId);
          if (g) g.commands = g.commands.filter(c => c.id !== row.dataset.id);
          renderGroupsEditor();
          persistQuickCommands();
        });
        row.querySelector('.qc-label')?.addEventListener('blur', () => persistQuickCommands());
        row.querySelector('.qc-command')?.addEventListener('blur', () => persistQuickCommands());
      });
    });
  }

  function moveGroup(id, delta) {
    collectQuickCommandGroups({ keepBlank: true });
    const idx = quickCommandGroups.findIndex(g => g.id === id);
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= quickCommandGroups.length) return;
    [quickCommandGroups[idx], quickCommandGroups[next]] = [quickCommandGroups[next], quickCommandGroups[idx]];
    renderGroupsEditor();
    persistQuickCommands();
  }

  function moveCommandInGroup(groupId, cmdId, delta) {
    collectQuickCommandGroups({ keepBlank: true });
    const g = quickCommandGroups.find(g => g.id === groupId);
    if (!g) return;
    const idx = g.commands.findIndex(c => c.id === cmdId);
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= g.commands.length) return;
    [g.commands[idx], g.commands[next]] = [g.commands[next], g.commands[idx]];
    renderGroupsEditor();
    persistQuickCommands();
  }

  function collectQuickCommandGroups(options = {}) {
    const groupEls = Array.from(document.querySelectorAll('#qc-editor .qc-group'));
    if (groupEls.length > 0) {
      quickCommandGroups = groupEls.map(groupEl => {
        const rows = Array.from(groupEl.querySelectorAll('.qc-row'));
        return {
          id: groupEl.dataset.groupId || makeGroupID(),
          name: groupEl.querySelector('.qc-group-name')?.value.trim() || '',
          commands: rows.map(row => ({
            id: row.dataset.id || makeID(),
            label: row.querySelector('.qc-label')?.value.trim() || '',
            command: row.querySelector('.qc-command')?.value || '',
          })),
        };
      });
    }
    if (options.keepBlank) return quickCommandGroups;
    return quickCommandGroups
      .filter(g => g.name || g.commands.some(c => c.command.trim()))
      .map(g => ({
        id: g.id || makeGroupID(),
        name: g.name || t('settings.quickCommands.groupFallback'),
        commands: g.commands
          .filter(c => c.command.trim() !== '')
          .map(c => ({
            id: c.id || makeID(),
            label: c.label || firstCommandLine(c.command),
            command: c.command,
          })),
      }));
  }

  function renderToolCallsEditor() {
    const editor = document.getElementById('tc-editor');
    if (!editor) return;
    if (customToolCalls.length === 0) {
      editor.innerHTML = `<div class="tc-empty">${t('settings.toolCalls.noCustomToolCalls')}</div>`;
      return;
    }
    editor.innerHTML = customToolCalls.map(tool => `
      <div class="tc-group" data-tool-id="${esc(tool.id)}">
        <div class="tc-group-header">
          <input class="input tc-group-name" value="${esc(tool.name)}" placeholder="${t('settings.toolCalls.namePlaceholder')}" />
          <div class="tc-group-header-actions${confirmingToolDeleteID === tool.id ? ' confirming' : ''}">
            ${confirmingToolDeleteID === tool.id ? `
              <span class="ai-confirm-label">${t('settings.toolCalls.confirmDelete')}</span>
              <button class="btn btn-danger btn-sm tc-confirm-delete" type="button">${t('common.delete')}</button>
              <button class="btn btn-ghost btn-sm tc-cancel-delete" type="button">${t('common.cancel')}</button>
            ` : `
              <div class="toggle-switch tc-enabled ${tool.enabled !== false ? 'on' : ''}"></div>
              <button class="btn btn-danger btn-icon btn-sm tc-delete" type="button" title="${t('settings.toolCalls.deleteToolCall')}">✕</button>
            `}
          </div>
        </div>
        <div class="tc-group-body">
          <textarea class="input tc-group-desc" rows="2" placeholder="${t('settings.toolCalls.descPlaceholder')}">${escText(tool.description)}</textarea>
          <textarea class="input tc-group-template" rows="1" wrap="off" placeholder="${t('settings.toolCalls.templatePlaceholder')}">${escText(tool.command_template)}</textarea>
          <div class="tc-params">
            <div class="tc-params-title">${t('settings.toolCalls.parameters')}</div>
            ${tool.parameters.map((p, pi) => `
              <div class="tc-param-row" data-pi="${pi}">
                <input class="input tc-param-name" value="${esc(p.name)}" placeholder="${t('settings.toolCalls.paramNamePlaceholder')}" />
                <input class="input tc-param-desc" value="${esc(p.description)}" placeholder="${t('settings.toolCalls.paramDescPlaceholder')}" />
                <label class="tc-param-required"><input type="checkbox" class="tc-param-required-cb" ${p.required ? 'checked' : ''} /> ${t('settings.toolCalls.required')}</label>
                <button class="btn btn-danger btn-icon btn-sm tc-param-delete" type="button" title="${t('common.delete')}">✕</button>
              </div>`).join('')}
          </div>
          <button class="btn btn-secondary btn-sm tc-add-param" type="button">${t('settings.toolCalls.addParameter')}</button>
        </div>
      </div>
    `).join('');

    editor.querySelectorAll('.tc-group').forEach(groupEl => {
      const toolId = groupEl.dataset.toolId;

      groupEl.querySelector('.tc-delete')?.addEventListener('click', () => {
        collectCustomToolCalls({ keepBlank: true });
        confirmingToolDeleteID = toolId;
        renderToolCallsEditor();
      });
      groupEl.querySelector('.tc-confirm-delete')?.addEventListener('click', () => {
        collectCustomToolCalls({ keepBlank: true });
        confirmingToolDeleteID = null;
        customToolCalls = customToolCalls.filter(tc => tc.id !== toolId);
        renderToolCallsEditor();
        persistCustomToolCalls();
      });
      groupEl.querySelector('.tc-cancel-delete')?.addEventListener('click', () => {
        confirmingToolDeleteID = null;
        renderToolCallsEditor();
      });
      groupEl.querySelector('.tc-enabled')?.addEventListener('click', e => {
        e.target.classList.toggle('on');
        collectCustomToolCalls({ keepBlank: true });
        persistCustomToolCalls();
      });
      groupEl.querySelector('.tc-add-param')?.addEventListener('click', () => {
        collectCustomToolCalls({ keepBlank: true });
        const tool = customToolCalls.find(tc => tc.id === toolId);
        if (tool) tool.parameters.push({ name: '', description: '', required: false });
        renderToolCallsEditor();
      });
      groupEl.querySelector('.tc-group-name')?.addEventListener('blur', () => persistCustomToolCalls());
      groupEl.querySelector('.tc-group-desc')?.addEventListener('blur', () => persistCustomToolCalls());
      groupEl.querySelector('.tc-group-template')?.addEventListener('blur', () => persistCustomToolCalls());
      groupEl.querySelectorAll('.tc-param-row').forEach(row => {
        row.querySelector('.tc-param-delete')?.addEventListener('click', () => {
          collectCustomToolCalls({ keepBlank: true });
          const tool = customToolCalls.find(tc => tc.id === toolId);
          if (tool) tool.parameters.splice(Number(row.dataset.pi), 1);
          renderToolCallsEditor();
          persistCustomToolCalls();
        });
        row.querySelector('.tc-param-name')?.addEventListener('blur', () => persistCustomToolCalls());
        row.querySelector('.tc-param-desc')?.addEventListener('blur', () => persistCustomToolCalls());
        row.querySelector('.tc-param-required-cb')?.addEventListener('change', () => persistCustomToolCalls());
      });
    });
  }

  function collectCustomToolCalls(options = {}) {
    const groupEls = Array.from(document.querySelectorAll('#tc-editor .tc-group'));
    if (groupEls.length > 0) {
      customToolCalls = groupEls.map(groupEl => {
        const paramRows = Array.from(groupEl.querySelectorAll('.tc-param-row'));
        return {
          id: groupEl.dataset.toolId || makeToolID(),
          name: groupEl.querySelector('.tc-group-name')?.value.trim() || '',
          description: groupEl.querySelector('.tc-group-desc')?.value || '',
          command_template: groupEl.querySelector('.tc-group-template')?.value || '',
          enabled: groupEl.querySelector('.tc-enabled')?.classList.contains('on') ?? true,
          parameters: paramRows.map(row => ({
            name: row.querySelector('.tc-param-name')?.value.trim() || '',
            description: row.querySelector('.tc-param-desc')?.value || '',
            required: row.querySelector('.tc-param-required-cb')?.checked || false,
          })),
        };
      });
    }
    if (options.keepBlank) return customToolCalls;
    return customToolCalls
      .filter(tc => tc.name || tc.command_template)
      .map(tc => ({
        id: tc.id || makeToolID(),
        name: tc.name,
        description: tc.description,
        command_template: tc.command_template,
        enabled: tc.enabled !== false,
        parameters: tc.parameters.filter(p => p.name.trim() !== ''),
      }));
  }

  function renderKnownHostsList() {
    const container = document.getElementById('kh-list');
    if (!container) return;
    if (kh.length === 0) {
      container.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">${t('settings.ssh.noKnownHosts')}</div>`;
      return;
    }
    // known_hosts can have one line per key type for the same host; group
    // them so each hostname renders as a single row (removal already
    // deletes every line for a hostname, see RemoveKnownHost on the Go side).
    const byHostname = new Map();
    kh.forEach(h => {
      if (!byHostname.has(h.hostname)) byHostname.set(h.hostname, []);
      byHostname.get(h.hostname).push(h);
    });

    container.innerHTML = Array.from(byHostname.entries()).map(([hostname, entries]) => `
      <div class="settings-row" data-hostname="${esc(hostname)}">
        <div>
          <div class="settings-row-label" style="font-family:var(--font-mono);font-size:12px;">${esc(hostname)}</div>
          ${entries.map(h => `<div class="settings-row-desc">${esc(h.key_type)} — ${esc(h.fingerprint)}</div>`).join('')}
        </div>
        ${confirmingHostname === hostname ? `
          <div class="kh-row-actions">
            <span class="ai-confirm-label">${t('settings.ssh.confirmRemoveHost', { h: hostname })}</span>
            <button class="btn btn-danger btn-sm kh-confirm-remove" type="button">${t('common.remove')}</button>
            <button class="btn btn-ghost btn-sm kh-cancel-remove" type="button">${t('common.cancel')}</button>
          </div>
        ` : `<button class="btn btn-danger btn-sm kh-remove" type="button">${t('common.remove')}</button>`}
      </div>`).join('');

    container.querySelectorAll('.settings-row').forEach(row => {
      const hostname = row.dataset.hostname;
      row.querySelector('.kh-remove')?.addEventListener('click', () => {
        confirmingHostname = hostname;
        renderKnownHostsList();
      });
      row.querySelector('.kh-cancel-remove')?.addEventListener('click', () => {
        confirmingHostname = null;
        renderKnownHostsList();
      });
      row.querySelector('.kh-confirm-remove')?.addEventListener('click', async () => {
        try {
          await removeKnownHost(hostname);
          showToast(t('toast.removed'));
          initSettings('ssh');
        } catch (e) {
          showToast('❌ ' + e);
          confirmingHostname = null;
          renderKnownHostsList();
        }
      });
    });
  }
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function escText(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
function makeID() { return 'qc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function makeGroupID() { return 'grp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function makeToolID() { return 'tc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function defaultWebSearchEndpoint(engine) {
  switch (engine) {
    case 'searxng': return 'https://searx.be/search';
    case 'brave': return 'https://api.search.brave.com/res/v1/web/search';
    case 'serpapi': return 'https://serpapi.com/search.json';
    case 'bing': return 'https://api.bing.microsoft.com/v7.0/search';
    case 'custom': return 'https://example.com/search?q={query}';
    default: return 'https://api.duckduckgo.com/';
  }
}
function firstCommandLine(s) {
  const real = (s || '').split(/\r?\n/).find(line => line.trim())?.trim() || '';
  if (!real) return t('settings.quickCommands.commandFallback');
  return real.split(/\\[nr]/)[0].trim() || t('settings.quickCommands.commandFallback');
}
function normalizeQuickCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return commands.map(c => ({
    id: c?.id || makeID(),
    label: c?.label || firstCommandLine(c?.command || ''),
    command: c?.command || '',
  })).filter(c => c.command || c.label);
}
function normalizeQuickCommandGroups(settings) {
  if (Array.isArray(settings.quick_command_groups) && settings.quick_command_groups.length > 0) {
    return settings.quick_command_groups.map(g => ({
      id: g.id || makeGroupID(),
      name: g.name || t('settings.quickCommands.groupFallback'),
      commands: normalizeQuickCommands(g.commands || []),
    }));
  }
  // Migrate legacy flat quick_commands into a single "Default" group
  const cmds = normalizeQuickCommands(settings.quick_commands || []);
  if (cmds.length > 0) {
    return [{ id: makeGroupID(), name: t('settings.quickCommands.legacyGroupName'), commands: cmds }];
  }
  return [];
}
function normalizeCustomToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map(tc => ({
    id: tc?.id || makeToolID(),
    name: tc?.name || '',
    description: tc?.description || '',
    command_template: tc?.command_template || '',
    enabled: tc?.enabled !== false,
    parameters: Array.isArray(tc?.parameters) ? tc.parameters.map(p => ({
      name: p?.name || '',
      description: p?.description || '',
      required: !!p?.required,
    })) : [],
  }));
}
