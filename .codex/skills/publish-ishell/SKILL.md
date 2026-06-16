---
name: publish-ishell
description: Build iShell for selected platforms and optionally upload release packages to the configured Gitea generic package registry. Use when the user asks to publish iShell, release iShell packages, build and upload desktop artifacts, or run the former Claude /publish command.
---

# Publish iShell

Build platform packages from the iShell repository and optionally upload them to:

`https://code.xxfe.com/api/packages/anhk/generic/iShell/`

## Inputs

- Version: use the user-provided version if present. Otherwise resolve it with `git rev-parse --short HEAD` and use `0.0.1-<hash>`.
- Token: prefer `GITEA_TOKEN` from the shell environment. If it is not set, ask the user for a Gitea Personal Access Token or confirm build-only mode.
- Platforms: if the user specifies targets, use exactly those targets. If they do not specify targets, choose defaults from the current platform:
  - On macOS (`darwin`), build `darwin/arm64` and `windows/amd64`.
  - On Windows, build `windows/amd64`.
  - On other platforms, ask the user which targets to build.

## Registry

- Host: `https://code.xxfe.com`
- Owner: `anhk`
- Package: `iShell`
- Token environment variable: `GITEA_TOKEN`

## Platform Commands

Run builds sequentially from the project root.

| Platform | Build command | Raw output |
|---|---|---|
| macOS ARM64 | `wails build -platform darwin/arm64` | `build/bin/iShell.app` |
| macOS Intel | `wails build -platform darwin/amd64` | `build/bin/iShell.app` |
| Windows AMD64 | `wails build -platform windows/amd64` | `build/bin/iShell.exe` |
| Windows installer | `wails build -platform windows/amd64 -nsis` | `build/bin/iShell-amd64-installer.exe` |

Package outputs as:

| Platform | Package filename |
|---|---|
| macOS ARM64 | `iShell-darwin-arm64.zip` |
| macOS Intel | `iShell-darwin-amd64.zip` |
| Windows AMD64 | `iShell-windows-amd64.exe` |
| Windows installer | `iShell-windows-amd64-installer.exe` |

For macOS targets, zip the `.app` bundle after each build:

```bash
cd build/bin && zip -r iShell-darwin-arm64.zip iShell.app && cd -
cd build/bin && zip -r iShell-darwin-amd64.zip iShell.app && cd -
```

For Windows targets, copy the raw executable to the package filename:

```bash
cp build/bin/iShell.exe build/bin/iShell-windows-amd64.exe
cp build/bin/iShell-amd64-installer.exe build/bin/iShell-windows-amd64-installer.exe
```

If a build fails, skip upload for that package and continue with remaining selected platforms.

## Upload

Skip upload if the user chose build-only mode.

Upload each successfully created package with:

```bash
curl -s -w "\nHTTP %{http_code}" \
  --user "anhk:<TOKEN>" \
  --upload-file "build/bin/<package-filename>" \
  "https://code.xxfe.com/api/packages/anhk/generic/iShell/<VERSION>/<package-filename>"
```

Handle HTTP status codes as:

- `201`: uploaded successfully.
- `409`: package already exists for that version; warn and continue.
- Any other status: report the response body and mark the package as failed.

## Summary

End with a concise summary containing:

- Version.
- Package page: `https://code.xxfe.com/anhk/iShell/packages`.
- Each selected file and its status.
- Example download URL for one uploaded package.
- Tip: set `export GITEA_TOKEN=<token>` in `~/.zshrc` to skip token input.
