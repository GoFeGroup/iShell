---
description: Stage all modified tracked files, commit with a generated message, and push to origin/main
argument-hint: "[commit message]  e.g. /commit-push fix: adjust red color  (omit to auto-generate)"
allowed-tools: ["Bash"]
---

# Commit and Push

## Step 1: Check Status

```bash
git status
git diff --stat
git log --oneline -3
```

If there are no staged or unstaged changes, report "没有需要提交的内容" and stop.

## Step 2: Stage Files

Stage all modified and deleted tracked files (do NOT use `git add -A` or `git add .` to avoid accidentally including secrets or untracked build artifacts):

```bash
git add -u
```

Also stage any new untracked files that are clearly part of the current work (e.g. new source files in `frontend/src/` or `backend/`). Do NOT stage `.env`, build output, or `.claude/` directory contents that aren't commands.

## Step 3: Compose Commit Message

If `$ARGUMENTS` is provided, use it as the commit message subject.

Otherwise, analyze the staged diff and write a concise conventional-commit message:
- Format: `<type>: <subject>` (e.g. `fix:`, `feat:`, `refactor:`, `chore:`)
- Subject line ≤ 72 characters
- Add a short body (2-4 bullet points) if the change spans multiple files or concerns

Always append:
```
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## Step 4: Commit

```bash
git commit -m "$(cat <<'EOF'
<message>
EOF
)"
```

## Step 5: Push

```bash
git push origin main
```

Print the resulting commit hash and confirm push success.
