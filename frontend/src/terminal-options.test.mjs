import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTerminalOptions } from './terminal-options.mjs';

const build = (overrides = {}) => buildTerminalOptions({
    connID: 'abc-123',
    platform: 'Win32',
    fontFamily: 'Menlo, monospace',
    fontSize: 16,
    theme: { background: '#000' },
    settings: {},
    ...overrides,
});

// Regression guard for the "claude CLI leaves stale glyphs in the leftmost
// columns" bug: convertEol rewrites bare LF into CRLF, which resets the
// cursor column mid-redraw and desyncs full-screen TUIs. Both data sources
// (SSH PTY / ConPTY) are real PTYs that already emit CRLF, so the option must
// never be set — not even to false, so a future reader can't flip it in place.
test('never sets convertEol for any terminal kind or platform', () => {
    for (const connID of ['local-uuid', 'ssh-conn-uuid']) {
        for (const platform of ['Win32', 'MacIntel', 'Linux x86_64']) {
            const options = build({ connID, platform });
            assert.equal('convertEol' in options, false, `convertEol present for ${connID} on ${platform}`);
        }
    }
});

test('local terminals on Windows declare their ConPTY backend', () => {
    assert.deepEqual(build({ connID: 'local-uuid', platform: 'Win32' }).windowsPty, { backend: 'conpty' });
});

test('local terminals on non-Windows platforms do not set windowsPty', () => {
    assert.equal('windowsPty' in build({ connID: 'local-uuid', platform: 'MacIntel' }), false);
    assert.equal('windowsPty' in build({ connID: 'local-uuid', platform: 'Linux x86_64' }), false);
});

test('SSH terminals never set windowsPty, even on Windows', () => {
    // The remote side of an SSH connection is a genuine Unix PTY; applying
    // ConPTY line-wrap heuristics to it would be wrong.
    assert.equal('windowsPty' in build({ connID: 'ssh-conn-uuid', platform: 'Win32' }), false);
});

test('passes display options through and resolves settings defaults', () => {
    const theme = { background: '#123456' };
    const options = build({
        connID: 'local-uuid',
        platform: 'MacIntel',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 14,
        theme,
        settings: {},
    });
    assert.equal(options.fontFamily, 'JetBrains Mono, monospace');
    assert.equal(options.fontSize, 14);
    assert.equal(options.theme, theme);
    // Defaults when settings omit the fields
    assert.equal(options.cursorBlink, true);
    assert.equal(options.cursorStyle, 'block');
    assert.equal(options.scrollback, 10000);
    // Required by @xterm/addon-search's decoration API
    assert.equal(options.allowProposedApi, true);
});

test('honors explicit cursor and scrollback settings', () => {
    const options = build({
        settings: { cursor_blink: false, cursor_style: 'underline', scrollback: 5000 },
    });
    assert.equal(options.cursorBlink, false);
    assert.equal(options.cursorStyle, 'underline');
    assert.equal(options.scrollback, 5000);
});
