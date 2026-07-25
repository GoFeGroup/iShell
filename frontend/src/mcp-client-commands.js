/**
 * Pure helpers for the MCP "client setup" commands shown in the settings
 * page (frontend/src/settings.js). Split out from settings.js — which pulls
 * in i18n.js/sidebar.js/quick-command.js and touches document/navigator at
 * import time — so this logic can be unit-tested without stubbing a DOM.
 */

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

// buildMCPClientCommands returns the add/remove CLI commands for every
// supported MCP client, pointed at iShell's MCP server on the given port.
export function buildMCPClientCommands(port) {
  return [
    { name: 'Claude', add: `claude mcp add --transport http ishell http://127.0.0.1:${port}/mcp`, remove: 'claude mcp remove ishell' },
    { name: 'Codex', add: `codex mcp add ishell --url http://127.0.0.1:${port}/mcp`, remove: 'codex mcp remove ishell' },
  ];
}

// renderMCPCommandHTML renders one labeled, copyable command row. label and
// copyLabel are passed in pre-translated so this stays free of an i18n
// dependency; command is HTML-escaped both in the visible <code> and in the
// data-cmd attribute the copy button reads from.
export function renderMCPCommandHTML(label, command, copyLabel) {
  return `<div class="mcp-command">
      <div class="mcp-command-label">${esc(label)}</div>
      <div class="mcp-command-line">
        <code>${esc(command)}</code>
        <button class="btn btn-secondary btn-sm mcp-copy-btn" data-cmd="${esc(command)}" type="button">${esc(copyLabel)}</button>
      </div>
    </div>`;
}
