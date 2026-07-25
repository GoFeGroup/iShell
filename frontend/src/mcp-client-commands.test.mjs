import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMCPClientCommands, renderMCPCommandHTML } from './mcp-client-commands.js';

test('buildMCPClientCommands() targets the given port for both Claude and Codex', () => {
  const clients = buildMCPClientCommands(7378);
  assert.deepEqual(clients, [
    { name: 'Claude', add: 'claude mcp add --transport http ishell http://127.0.0.1:7378/mcp', remove: 'claude mcp remove ishell' },
    { name: 'Codex', add: 'codex mcp add ishell --url http://127.0.0.1:7378/mcp', remove: 'codex mcp remove ishell' },
  ]);
});

test('buildMCPClientCommands() reflects a non-default port in every add command', () => {
  const clients = buildMCPClientCommands(9999);
  for (const client of clients) {
    assert.match(client.add, /:9999\/mcp$/);
  }
});

test('renderMCPCommandHTML() embeds the label, command, and copy-button label as visible text', () => {
  const html = renderMCPCommandHTML('Add iShell', 'claude mcp add ishell http://127.0.0.1:7378/mcp', 'Copy');
  assert.match(html, /mcp-command-label">Add iShell</);
  assert.match(html, /<code>claude mcp add ishell http:\/\/127\.0\.0\.1:7378\/mcp<\/code>/);
  assert.match(html, />Copy</);
});

test('renderMCPCommandHTML() carries the raw command in data-cmd for the copy button to read', () => {
  const html = renderMCPCommandHTML('Add iShell', 'claude mcp add ishell http://127.0.0.1:7378/mcp', 'Copy');
  assert.match(html, /data-cmd="claude mcp add ishell http:\/\/127\.0\.0\.1:7378\/mcp"/);
});

// esc() (shared with settings.js's own HTML-escaping helper) only neutralizes
// &, " and < — the characters that matter for breaking out of a double-quoted
// attribute or opening a new tag — so a trailing '>' passes through as-is.
test('renderMCPCommandHTML() escapes HTML-significant characters in the command', () => {
  const html = renderMCPCommandHTML('Add iShell', '<script>alert(1)</script>&"', 'Copy');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script>alert\(1\)&lt;\/script>&amp;&quot;/);
});

test('renderMCPCommandHTML() escapes HTML-significant characters in the label and copy label', () => {
  const html = renderMCPCommandHTML('<b>Add</b>', 'cmd', '<i>Copy</i>');
  assert.doesNotMatch(html, /<b>|<i>/);
  assert.match(html, /mcp-command-label">&lt;b>Add&lt;\/b></);
  assert.match(html, />&lt;i>Copy&lt;\/i></);
});
