// Pure construction of the xterm.js Terminal options object, extracted from
// terminal.js so its PTY-compatibility invariants can be asserted by node
// --test without a DOM or the xterm package (same pattern as
// zmodem-protocol.mjs).
export function buildTerminalOptions({ connID, platform, fontFamily, fontSize, theme, settings }) {
    const options = {
        fontSize,
        fontFamily,
        letterSpacing: 0,
        cursorBlink: settings?.cursor_blink !== false,
        cursorStyle: settings?.cursor_style || 'block',
        scrollback: settings?.scrollback || 10000,
        theme,
        allowTransparency: false,
        // convertEol must stay off (i.e. never appear here): both data sources
        // are real PTYs (SSH PTY / ConPTY) that already emit CRLF for line
        // breaks. Rewriting bare LF to CRLF resets the column mid-redraw and
        // desyncs full-screen TUIs (e.g. the claude CLI), leaving stale glyphs
        // in the leftmost columns.
        //
        // allowProposedApi is required by @xterm/addon-search's match-highlight
        // decorations, which call the still-proposed Terminal.registerDecoration
        // API.
        allowProposedApi: true,
    };
    // Local terminals on Windows are ConPTY-backed; this enables xterm.js's
    // ConPTY-specific line-wrap heuristics. SSH terminals get a genuine Unix
    // PTY on the remote side regardless of the local OS, so they never set it.
    if (connID.startsWith('local-') && platform.startsWith('Win')) {
        options.windowsPty = { backend: 'conpty' };
    }
    return options;
}
