# Repository Guidelines

## Project Structure & Module Organization

iShell is a Wails desktop app with a Go backend and Vite frontend. Root Go entry points live in `main.go` and `app.go`; Wails configuration is in `wails.json`. Backend packages are under `backend/`: `backend/ssh` handles SSH, terminal, SFTP, keys, and known hosts, while `backend/storage` owns persisted sessions and settings. Frontend source is in `frontend/src`. Static design prototypes are in `prototypes/`; generated output goes under `build/` and `frontend/dist/`.

## Build, Test, and Development Commands

- `make dev`: run `wails dev` with frontend hot reload.
- `make build`: build the current platform via `wails build`.
- `make build-mac-arm64` / `make build-mac-amd64`: build macOS.
- `make build-windows`: build Windows AMD64.
- `make clean`: remove `build/bin`.
- `cd frontend && npm run dev`: run the Vite frontend only.
- `cd frontend && npm run build`: produce assets for Wails embedding.
- `go test ./...`: run all Go package tests.
- `cd frontend && npm test`: run frontend tests (`node --test src/*.test.mjs`).

Install frontend dependencies with `cd frontend && npm install`; Wails also runs this via `frontend:install`.

## Coding Style & Naming Conventions

Use `gofmt` for Go files and idiomatic package names such as `ssh` and `storage`. Keep Wails-bound methods on `App` exported only when callable from the frontend. Use lower camelCase in JavaScript (`activeTab`, `showPanel`) and kebab-case filenames (`session-form.js`). Group frontend code by feature: API calls in `api.js`, terminal behavior in `terminal.js`, SFTP behavior in `sftp.js`.

## Testing Guidelines

Go tests live as `*_test.go` beside the package under test (`backend/ssh`, `backend/storage`, `backend/ai`, `backend/mcpserver`, `backend/local`, `backend/termout`, and the top-level `backend` package); prefer table-driven tests for storage, key handling, and path logic. Run `go test ./...` before backend changes. Tests that construct a real `*App` and call `Startup` must sandbox it with `t.Setenv("APPDATA", t.TempDir())` — `dataDir()` honors `APPDATA` as a cross-platform override, not just on Windows — otherwise they touch the real user profile.

Frontend tests live as `*.test.mjs` beside the module under test (e.g. `zmodem-protocol.test.mjs`, `i18n.test.mjs`) and run via Node's built-in test runner (`cd frontend && npm test`), no framework or jsdom dependency. Favor modules with logic that's separable from DOM wiring; where a module touches `window`/`document`/`navigator`/`localStorage` at import time, stub those globals with `globalThis.x = ...` before a *dynamic* `import()` of the module — a static `import` is hoisted above the stubs and will crash. For frontend UI changes with no unit-testable logic, run `cd frontend && npm run build` to catch import and bundling errors.

## Commit & Pull Request Guidelines

The existing history uses short, imperative summaries with optional conventional prefixes, for example `feat: initial implementation of iShell SSH client`. Keep commits focused and use prefixes such as `feat:`, `fix:`, or `chore:` when helpful.

Pull requests should include a summary, testing performed, and screenshots or recordings for visible UI changes. Link related issues when available. Note platform-specific requirements for macOS or Windows builds, especially when changing Wails, SSH, or packaging behavior.

## Security & Configuration Tips

Do not commit private keys, passwords, generated session stores, or local `known_hosts` data. Treat SSH credentials and passphrases as runtime-only values. Keep generated artifacts out of reviews unless the change is specifically about packaging or release output.
