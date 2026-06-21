---
description: Build iShell for selected platforms and publish to Gitea package registry
argument-hint: "[version]  e.g. /publish 1.0.0  (default: 0.0.1-<git-hash>)"
allowed-tools: ["Bash", "AskUserQuestion"]
---

# Publish iShell to Gitea Package Registry

Build platform packages and upload to `https://code.xxfe.com/api/packages/anhk/generic/iShell/`.

## Registry Info

- **Registry**: `https://code.xxfe.com`
- **Owner / Package**: `anhk / iShell`
- **Token env var**: `GITEA_TOKEN` (set in shell profile to skip the prompt)

---

## Step 1: Resolve Version

If `$ARGUMENTS` is provided, use it as-is.

Otherwise run:
```bash
echo "0.0.1-$(git rev-parse --short HEAD)"
```

Store the result as `VERSION`.

## Step 2: Resolve Token

Run the following to check if a token is already in the environment:
```bash
echo "${GITEA_TOKEN:-__unset__}"
```

- If the output is **not** `__unset__`, use that value as the token. Skip to Step 3.
- If the output **is** `__unset__`, ask the user:
  - **Question**: "未检测到 GITEA_TOKEN 环境变量，请输入 Gitea Personal Access Token（在 code.xxfe.com → Settings → Applications 生成，或设置 export GITEA_TOKEN=... 到 shell profile 以后跳过此步）"
  - **Header**: "Gitea Token"
  - **Options**:
    - `在 Other 框粘贴 Token` — 用户在文本框粘贴
    - `跳过上传，仅构建` — 只执行 build，不上传

## Step 3: Select Platforms

If the user specified targets in their request, use exactly those targets and skip the prompt.

Otherwise, choose defaults from the current platform:
- On macOS (`darwin`), build `darwin/arm64` and `windows/amd64`.
- On Windows, build `windows/amd64`.
- On other platforms, ask the user which platforms to build:

- **Question**: "选择要构建并发布的平台"
- **Header**: "目标平台"
- **multiSelect**: true
- **Options**:
  - `macOS ARM64 (Apple Silicon)` — `wails build -platform darwin/arm64`
  - `macOS Intel (AMD64)` — `wails build -platform darwin/amd64`
  - `Windows AMD64 (.exe)` — `wails build -platform windows/amd64`
  - `Windows 安装包 (.exe installer)` — `wails build -platform windows/amd64 -nsis`（需要 brew install nsis）

## Step 4: Build

Run builds **sequentially** for each selected platform from the project root.

| Platform | Build Command | Raw Output |
|---|---|---|
| macOS ARM64 | `wails build -platform darwin/arm64` | `build/bin/iShell.app` |
| macOS Intel | `wails build -platform darwin/amd64` | `build/bin/iShell.app` |
| Windows AMD64 | `wails build -platform windows/amd64` | `build/bin/iShell.exe` |
| Windows 安装包 | `wails build -platform windows/amd64 -nsis` | `build/bin/iShell-amd64-installer.exe` |

**macOS**: After each build, zip the `.app` bundle. Use a temp copy to avoid overwriting between arm64 and amd64 builds:
```bash
# arm64
cd build/bin && zip -r iShell-darwin-arm64.zip iShell.app && cd -

# amd64 (rename first to avoid collision if built after arm64)
cd build/bin && zip -r iShell-darwin-amd64.zip iShell.app && cd -
```

**Windows**: The `.exe` is ready to upload as-is. Copy to a named file:
```bash
cp build/bin/iShell.exe build/bin/iShell-windows-amd64.exe
cp build/bin/iShell-amd64-installer.exe build/bin/iShell-windows-amd64-installer.exe
```

Package filename mapping:

| Platform | Upload Filename |
|---|---|
| macOS ARM64 | `iShell-darwin-arm64.zip` |
| macOS Intel | `iShell-darwin-amd64.zip` |
| Windows AMD64 | `iShell-windows-amd64.exe` |
| Windows 安装包 | `iShell-windows-amd64-installer.exe` |

Show a progress line for each build: `🔨 Building <platform>…` → `✅ Done` or `❌ Failed`.

If a build fails, skip its upload and continue with the remaining platforms.

## Step 5: Upload

Skip this step if user chose "仅构建" in Step 2.

For each successfully built package:
```bash
curl -s -w "\nHTTP %{http_code}" \
  --user "anhk:<TOKEN>" \
  --upload-file "build/bin/<package-filename>" \
  "https://code.xxfe.com/api/packages/anhk/generic/iShell/<VERSION>/<package-filename>"
```

HTTP response handling:
- `201` → ✅ uploaded
- `409` → ⚠️ already exists (version conflict), show warning and continue
- other → ❌ failed, show response body

## Step 6: Print Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 iShell <VERSION> published
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Package page:
   https://code.xxfe.com/anhk/iShell/packages

 Files:
   ✅ iShell-darwin-arm64.zip   (N MB)
   ✅ iShell-windows-amd64.exe  (N MB)

 Download (example):
   curl -O \
     https://code.xxfe.com/api/packages/anhk/generic/iShell/<VERSION>/iShell-darwin-arm64.zip
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Tip: set `export GITEA_TOKEN=<your-token>` in `~/.zshrc` to skip the token prompt next time.
