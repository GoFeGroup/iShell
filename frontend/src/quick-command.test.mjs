import assert from 'node:assert/strict';
import test from 'node:test';

// quick-command.js touches window/document as soon as it's imported (a
// module-level window.addEventListener call) and again inside
// updateQuickCommandUI()/renderQuickCommands(); it also imports i18n.js,
// which independently needs document/localStorage/navigator at import time
// (see i18n.test.mjs for why). A dynamic import after stubbing keeps this
// file dependency-free like the rest of the suite — a static import would
// be hoisted above the stubs. Passing a barGetter that always returns null
// makes initQuickCommands()'s render pass a no-op (renderQuickCommands
// bails out as soon as `bar` is falsy), so no further DOM surface is needed.
globalThis.window = { addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  documentElement: { setAttribute: () => {}, getAttribute: () => null },
};
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
// Node 21+ exposes a getter-only globalThis.navigator; plain assignment throws.
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, writable: true, configurable: true });
globalThis.CustomEvent = class CustomEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.detail = opts.detail;
  }
};

const { initQuickCommands, findQuickCommandByShortcut, shortcutLabelForIndex } = await import('./quick-command.js');

function ctrlDigit(n, overrides = {}) {
  return { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, code: `Digit${n}`, ...overrides };
}

function withActiveConn(connID, settings) {
  initQuickCommands(settings, () => connID, () => null);
}

test('shortcutLabelForIndex renders a 1-based Ctrl+N label', () => {
  assert.equal(shortcutLabelForIndex(0), 'Ctrl+1');
  assert.equal(shortcutLabelForIndex(8), 'Ctrl+9');
});

test('finds the command at the shortcut position in the current group', () => {
  withActiveConn('conn-1', {
    quick_command_groups: [{ id: 'g1', name: 'G1', commands: [{ command: 'ls -la' }, { command: 'pwd' }] }],
  });
  assert.equal(findQuickCommandByShortcut(ctrlDigit(1)).command, 'ls -la');
  assert.equal(findQuickCommandByShortcut(ctrlDigit(2)).command, 'pwd');
});

test('falls back to the legacy flat quick_commands list when no groups are configured', () => {
  withActiveConn('conn-1', {
    quick_commands: [{ command: 'whoami' }, { command: 'uptime' }],
  });
  assert.equal(findQuickCommandByShortcut(ctrlDigit(1)).command, 'whoami');
});

test('groups take precedence over the legacy flat list when both are present', () => {
  withActiveConn('conn-1', {
    quick_command_groups: [{ id: 'g1', name: 'G1', commands: [{ command: 'from-group' }] }],
    quick_commands: [{ command: 'from-legacy' }],
  });
  assert.equal(findQuickCommandByShortcut(ctrlDigit(1)).command, 'from-group');
});

test('returns null when the shortcut index has no configured command', () => {
  withActiveConn('conn-1', {
    quick_command_groups: [{ id: 'g1', name: 'G1', commands: [{ command: 'only-one' }] }],
  });
  assert.equal(findQuickCommandByShortcut(ctrlDigit(2)), null);
});

test('returns null when there is no active terminal connection', () => {
  withActiveConn(null, {
    quick_command_groups: [{ id: 'g1', name: 'G1', commands: [{ command: 'ls' }] }],
  });
  assert.equal(findQuickCommandByShortcut(ctrlDigit(1)), null);
});

test('returns null for Ctrl+digit combined with any other modifier', () => {
  withActiveConn('conn-1', {
    quick_command_groups: [{ id: 'g1', name: 'G1', commands: [{ command: 'ls' }] }],
  });
  assert.equal(findQuickCommandByShortcut(ctrlDigit(1, { metaKey: true })), null);
  assert.equal(findQuickCommandByShortcut(ctrlDigit(1, { altKey: true })), null);
  assert.equal(findQuickCommandByShortcut(ctrlDigit(1, { shiftKey: true })), null);
  assert.equal(findQuickCommandByShortcut(ctrlDigit(1, { ctrlKey: false })), null);
});

test('returns null for non-digit keys and ignores Digit0', () => {
  withActiveConn('conn-1', {
    quick_command_groups: [{ id: 'g1', name: 'G1', commands: [{ command: 'ls' }] }],
  });
  assert.equal(findQuickCommandByShortcut(ctrlDigit(0)), null);
  assert.equal(findQuickCommandByShortcut({ ctrlKey: true, code: 'KeyA' }), null);
  assert.equal(findQuickCommandByShortcut({ ctrlKey: true, code: '' }), null);
});

test('skips entries with an empty command when computing shortcut positions', () => {
  withActiveConn('conn-1', {
    quick_command_groups: [{
      id: 'g1',
      name: 'G1',
      commands: [{ command: '' }, { command: 'second' }, null],
    }],
  });
  assert.equal(findQuickCommandByShortcut(ctrlDigit(1)).command, 'second');
  assert.equal(findQuickCommandByShortcut(ctrlDigit(2)), null);
});
