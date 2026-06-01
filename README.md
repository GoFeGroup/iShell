# iShell

iShell is a desktop SSH client built with Wails, Go, Vite, and xterm.js. It provides tabbed remote terminals, profile management, host-key verification, and an integrated SFTP file panel.

## Features

- SSH terminal sessions with xterm.js rendering.
- Multiple terminal tabs with reusable terminal instances.
- Local terminal mode for opening a shell on the current machine.
- Session profiles with labels, groups, host, port, username, password or private-key authentication.
- SFTP file browser for remote SSH sessions, with upload, download, rename, delete, and chmod actions.
- Remote SFTP panel follows the terminal-reported current working directory when the shell emits OSC cwd reports.
- Settings for theme, font, cursor, scrollback, host-key checking, and known hosts.
- Cross-platform app packaging through Wails.

## Tech Stack

- Backend: Go, Wails v2, `golang.org/x/crypto/ssh`, `github.com/pkg/sftp`, SQLite via `modernc.org/sqlite`.
- Frontend: Vite, vanilla JavaScript, xterm.js.
- Desktop shell: Wails native window with embedded frontend assets.

## Requirements

- Go 1.22 or newer.
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
├── app.go                  # Wails-bound backend methods
├── main.go                 # Wails app bootstrap and window options
├── backend/
│   ├── ssh/                # SSH, PTY, SFTP, keys, known_hosts
│   ├── local/              # Local terminal sessions
│   └── storage/            # SQLite-backed sessions and settings
├── frontend/
│   ├── index.html
│   └── src/
│       ├── api.js          # Wails IPC wrappers
│       ├── main.js         # App shell, tabs, panels, shortcuts
│       ├── terminal.js     # xterm.js lifecycle and terminal events
│       ├── sftp.js         # SFTP panel and transfer UI
│       └── settings.js     # Settings panel
├── prototypes/             # Static design prototypes
├── build/                  # Generated app binaries
└── wails.json              # Wails configuration
```

## Runtime Data

iShell stores sessions and settings in a local SQLite database.

| Platform | Data directory |
| --- | --- |
| macOS | `~/Library/Application Support/iShell` |
| Windows | `%APPDATA%\iShell` |
| Linux | `$XDG_CONFIG_HOME/ishell` or `~/.config/ishell` |

Do not commit local databases, private keys, passwords, or known-host data.

## SSH And SFTP Notes

- SFTP is available for remote SSH sessions only. Local terminal tabs do not show the SFTP button.
- The SFTP remote pane uses the terminal's reported current directory when available, then falls back to the SFTP session working directory.
- Host-key verification is enabled by default. Unknown hosts are prompted and can be stored in `known_hosts`.
- Private keys can be selected and validated from the profile form.

## Keyboard Shortcuts

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Switch tab | `Cmd+1` ... `Cmd+9` | `Alt+1` ... `Alt+9` |
| Toggle sidebar | `Cmd+B` | `Ctrl+B` |
| Fullscreen | `Cmd+Enter` | `Alt+Enter` |
| Find in terminal | `Cmd+F` | `Ctrl+F` |
| Close current tab | `Cmd+W` | `Alt+W` |

## Troubleshooting

- If Go tests fail immediately after `npm run build` with a missing `frontend/dist/assets/*.js` embed error, rerun `go test ./...` after the Vite build finishes. Running both at the same time can race while hashed frontend assets are being replaced.
- If SFTP opens at the home directory instead of the terminal directory, confirm the remote shell emits a supported current-directory OSC report such as OSC 7 or `OSC 1337;CurrentDir=...`.
- If frontend imports or generated assets are stale, run `cd frontend && npm run build`.

## License

See [LICENSE](LICENSE).
