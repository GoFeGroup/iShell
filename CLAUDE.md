# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
make dev                  # wails dev — Go + Vite hot reload
make build                # build for current platform
make build-mac-arm64      # macOS Apple Silicon
make build-mac-amd64      # macOS Intel
make build-windows        # cross-compile Windows
make build-windows-installer  # Windows NSIS installer (requires: brew install nsis)
make clean

go test ./...             # run all Go tests
cd frontend && npm test        # run frontend tests (node --test src/*.test.mjs)
cd frontend && npm run build   # check frontend bundling errors
```

## Architecture

iShell is a **Wails v2** desktop app: Go backend + Vite/vanilla-JS frontend communicating over Wails IPC (WebSocket in dev, direct bridge in production).

### Request flow

```
User keystroke
  → xterm.js onData  (frontend/src/terminal.js)
  → serial input queue  (makeInputSender, one IPC call in-flight at a time)
  → window.go.main.App.SendInput  (Wails IPC)
  → app.go App.SendInput
  → backend/ssh Manager.SendInput
  → TermSession.Write  →  inputCh channel  →  pumpInput goroutine  →  SSH stdin
```

SSH output flows back via `runtime.EventsEmit("terminal:data:<connID>", base64)` → `window.runtime.EventsOn` → `term.write()`.

### Key files

| File | Role |
|---|---|
| `main.go` | Wails app bootstrap, window options |
| `app.go` | All methods bound to the frontend (`App` struct) |
| `backend/ssh/manager.go` | Manages active SSH connections (`Conn` map, SFTP lazy-init) |
| `backend/ssh/session.go` | PTY session: `inputCh` channel serialises stdin writes from concurrent goroutines |
| `backend/ssh/keymgr.go` | Load/validate SSH private keys |
| `backend/ssh/knownhosts.go` | known_hosts read/write/verify |
| `backend/ssh/sftp.go` | Upload/download helpers |
| `backend/storage/store.go` | SQLite via `modernc.org/sqlite` — sessions + settings |
| `backend/storage/models.go` | `Session`, `Settings`, `AuthType` structs |
| `frontend/src/api.js` | Typed wrappers over `window.go.main.App.*` |
| `frontend/src/terminal.js` | xterm.js lifecycle; terminal instances are **reused** across tab switches |
| `frontend/src/main.js` | App shell: tab management, panels, keyboard shortcuts |
| `frontend/src/settings.js` | Settings panel (injected HTML + save/discard footer) |

### IPC pattern

Every exported method on `App` in `app.go` is callable from JS as `window.go.main.App.MethodName(args)`. Wails generates TypeScript bindings in `frontend/wailsjs/go/`. Use `window.runtime.*` (from `frontend/wailsjs/runtime/runtime.js`) for window management and events — **not** browser APIs like `document.requestFullscreen`.

### Terminal instance lifecycle

`createTerminal(connID, settings)` in `terminal.js` creates an xterm instance once per `connID` and reuses it on tab switches (re-appending the DOM element). It only rebuilds if font settings change. `destroyTerminal(connID)` must be called on disconnect to clean up the Wails `EventsOn` listener and ResizeObserver.

### Keyboard shortcuts

- Mac: `Cmd+Enter` fullscreen, `Cmd+B` sidebar, `Cmd+F` find
- Windows/Linux: `Alt+Enter` fullscreen, `Alt+B` sidebar, `Alt+F` find
- Platform detected via `navigator.platform.startsWith('Mac')`
- `attachCustomKeyEventHandler` intercepts `Cmd/Alt+Enter` in xterm before it reaches SSH

### Data directory

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/iShell` |
| Windows | `%APPDATA%\iShell` |
| Linux | `$XDG_CONFIG_HOME/ishell` or `~/.config/ishell` |

`dataDir()` in `app.go` checks the `APPDATA` env var *before* the OS switch, on every platform, not just Windows. This is what lets tests sandbox `App.Startup` away from the real user profile via `t.Setenv("APPDATA", t.TempDir())` regardless of the host OS (see `backend/mcpserver_app_test.go`) — if that check is ever moved back inside the `windows` case, those tests silently fall through to the real `~/Library/Application Support/iShell` / `~/.config/ishell` on macOS/Linux instead of a temp dir.

### Wails fullscreen API

Use `window.runtime.WindowFullscreen()` / `window.runtime.WindowUnfullscreen()` (lowercase 's'). `window.runtime.WindowIsFullscreen()` returns `Promise<boolean>`. Do **not** use `document.requestFullscreen()` — it is blocked in WKWebView.
