# iShell

iShell is a desktop SSH client built with Wails, Go, Vite, and xterm.js. It provides tabbed remote terminals, profile management, host-key verification, SSH port forwarding, an integrated SFTP file panel, and an AI sidebar that can operate the terminal with your approval.

## Features

### Terminal

- SSH terminal sessions with xterm.js rendering; terminal instances are reused across tab switches.
- Multiple terminal tabs and split terminal panes.
- Local terminal mode for opening a shell on the current machine (ConPTY on Windows, pty on macOS/Linux).
- Grouped quick-command bar with escape sequences and keyboard shortcuts.
- In-terminal search with match options, configurable right-click action (context menu or paste), copy-on-select, font ligatures, and CJK font fallback.

### SSH

- Session profiles with labels, groups, host, port, username, and SSH jump host support.
- Authentication by password, private key, or SSH agent (including Pageant on Windows).
- Host-key verification enabled by default; unknown hosts are prompted and can be stored in `known_hosts`.
- Port forwarding: local, remote, and dynamic (SOCKS5) tunnels. Rules are persisted per session profile with optional auto-start, and ad-hoc tunnels can be opened from the port-forward panel.

### File transfer

- SFTP file browser for remote SSH sessions, with upload, download, rename, delete, mkdir, and chmod actions; transfers are queued, cancellable, and persisted with progress records.
- Remote SFTP panel follows the terminal-reported current working directory when the shell emits OSC cwd reports (OSC 7 or `OSC 1337;CurrentDir=...`).
- Zmodem (`sz`/`rz`) file transfer support over SSH terminals, including multi-file and large transfers.

### AI sidebar

- Chat with any OpenAI-compatible chat completions API. Multiple providers can be configured; each chat session can pick its provider, defaulting to the first one.
- Built-in tools the model can call: `terminal_run` (sends a command, pauses for human approval unless auto-exec is enabled for that chat), `terminal_read`, `terminal_quick_command`, `open_url` (fetches and extracts text from a public web page), `read_local_file`, and `list_local_dir`. Custom tool calls can be defined in settings.
- AI quick actions: generate a shell command suggestion from a natural-language prompt.
- Chat sessions are auto-titled, stored locally per terminal target, and never included in YAML config export/import.

### MCP server

- Opt-in local MCP server (Streamable HTTP on `127.0.0.1`, default port 7378) that exposes open terminal tabs to external MCP clients such as the official `claude` and `codex` CLIs — list terminals, send input, and read output.
- **Security note:** once enabled, any local process that can reach the port is fully trusted to read and execute commands in the terminals it names; there is no per-call approval, unlike the AI sidebar's tool loop.

### General

- Settings for theme, color scheme, font, cursor, scrollback, bell style, host-key checking, known hosts, and interface language (English, Simplified/Traditional Chinese), applied live with no Save/Discard step.
- YAML config import/export for sessions, port-forward rules, and settings.
- Cross-platform app packaging through Wails, with the build version injected at compile time from git tags.

## Tech Stack

- Backend: Go, Wails v2, `golang.org/x/crypto/ssh`, `github.com/pkg/sftp`, SQLite via `modernc.org/sqlite`, MCP via `github.com/mark3labs/mcp-go`.
- Frontend: Vite, vanilla JavaScript, xterm.js (fit/search/web-links/ligatures addons), zmodem.js, marked + highlight.js + DOMPurify for AI chat rendering.
- AI sidebar: any OpenAI-compatible chat completions API (configurable base URL, key, model per provider).
- Desktop shell: Wails native window with embedded frontend assets.

## Requirements

- Go 1.25 or newer.
- Node.js and npm.
- Wails CLI v2.

Install Wails if it is not already available:

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
```

Install frontend dependencies:

```bash
cd frontend
npm install
```

Wails also runs `npm install` through `frontend:install` when needed.

## Development

Run the app in development mode:

```bash
make dev
```

This starts Wails and the Vite dev server. The frontend dev server is configured in `wails.json` as `http://127.0.0.1:5173`.

Useful checks:

```bash
go test ./...
cd frontend && npm test
cd frontend && npm run build
```

## Build

Build the current platform:

```bash
make build
```

Platform-specific builds:

```bash
make build-mac-arm64
make build-mac-amd64
make build-windows
```

Windows cross-builds from macOS require `mingw-w64`:

```bash
brew install mingw-w64
```

Windows installer builds require NSIS:

```bash
brew install nsis
make build-windows-installer
```

Clean generated binaries:

```bash
make clean
```

## Project Structure

```text
.
├── main.go                    # Wails app bootstrap and window options
├── backend/
│   ├── app.go                 # All Wails-bound backend methods (App struct)
│   ├── version.go             # Build version, set via -ldflags
│   ├── ai/                    # AI sidebar agent: OpenAI-compatible client, tools,
│   │                          #   web page reading, local fs tools, quick commands
│   ├── ssh/                   # SSH, PTY, SFTP, keys, known_hosts, agent auth,
│   │                          #   port forwarding (local/remote/SOCKS5)
│   ├── local/                 # Local terminal sessions (ConPTY / pty)
│   ├── mcpserver/             # Opt-in local MCP server exposing terminals
│   ├── termout/               # Terminal output capture/buffering
│   ├── osutil/                # Platform helpers (window focus, ESC key)
│   └── storage/               # SQLite-backed sessions, settings, port-forward
│                              #   rules, AI chat history, YAML export/import
├── frontend/
│   ├── index.html
│   └── src/
│       ├── api.js                 # Wails IPC wrappers
│       ├── main.js                # App shell, tabs, panels, shortcuts
│       ├── terminal.js            # xterm.js lifecycle and terminal events
│       ├── sftp.js                # SFTP panel and transfer UI
│       ├── zmodem.js              # sz/rz file transfer over the terminal
│       ├── port-forward-panel.js  # Port-forward rules and active tunnels
│       ├── ai-sidebar.js          # AI chat sidebar UI
│       ├── mcp-client-commands.js # MCP client setup command snippets
│       ├── quick-command.js       # Grouped quick-command bar
│       ├── i18n.js                # Interface language strings
│       └── settings.js            # Settings panel
├── prototypes/                # Static design prototypes
├── build/                     # Generated app binaries
└── wails.json                 # Wails configuration
```

## Runtime Data

iShell stores sessions and settings in a local SQLite database.

| Platform | Data directory |
| --- | --- |
| macOS | `~/Library/Application Support/iShell` |
| Windows | `%APPDATA%\iShell` |
| Linux | `$XDG_CONFIG_HOME/ishell` or `~/.config/ishell` |

The `APPDATA` environment variable overrides the data directory on every platform (used by tests to sandbox away from the real profile).

Do not commit local databases, private keys, passwords, or known-host data.

## SSH And SFTP Notes

- SFTP is available for remote SSH sessions only. Local terminal tabs do not show the SFTP button.
- The SFTP remote pane uses the terminal's reported current directory when available, then falls back to the SFTP session working directory.
- Host-key verification is enabled by default. Unknown hosts are prompted and can be stored in `known_hosts`.
- Private keys can be selected and validated from the profile form. SSH agent authentication is detected automatically (`SSH_AUTH_SOCK` on Unix, Pageant/OpenSSH agent on Windows).

## AI Sidebar Notes

- Configure providers in Settings: enable the AI sidebar, then add one or more OpenAI-compatible providers (base URL, API key, model). The first provider is the default; each chat can switch providers.
- When a terminal tab is active, the model can call `terminal_run` (sends a command, pauses for human approval unless auto-exec is on for that chat) and `terminal_read` (reads recent output without sending input).
- `open_url` fetches public web pages only — private/loopback addresses are blocked.
- Chat history is stored locally per terminal target and is never included in YAML config export/import.

## MCP Server Notes

- Enable in Settings; the server listens on `127.0.0.1:<port>` (default 7378) using MCP Streamable HTTP.
- The settings panel shows ready-to-copy client setup commands for the `claude` and `codex` CLIs.
- Any process with access to the port can read and execute commands in the named terminals without per-call approval — enable only when needed.

## Keyboard Shortcuts

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Switch tab | `Cmd+1` ... `Cmd+9` | `Alt+1` ... `Alt+9` |
| Toggle sidebar | `Cmd+B` | `Alt+B` |
| Fullscreen | `Cmd+Enter` | `Alt+Enter` |
| Find in terminal | `Cmd+F` | `Alt+F` |
| Close current tab | `Cmd+W` | `Alt+W` |

## Troubleshooting

- If Go tests fail immediately after `npm run build` with a missing `frontend/dist/assets/*.js` embed error, rerun `go test ./...` after the Vite build finishes. Running both at the same time can race while hashed frontend assets are being replaced.
- If SFTP opens at the home directory instead of the terminal directory, confirm the remote shell emits a supported current-directory OSC report such as OSC 7 or `OSC 1337;CurrentDir=...`.
- If frontend imports or generated assets are stale, run `cd frontend && npm run build`.

## License

See [LICENSE](LICENSE).
