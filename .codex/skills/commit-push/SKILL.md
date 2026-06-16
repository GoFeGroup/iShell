---
name: commit-push
description: Stage modified and deleted tracked files, optionally stage clearly related new source files, create a concise conventional commit, and push to origin/main. Use when the user asks to commit and push, run the former Claude /commit-push command, or commit current work with a generated or provided message.
---

# Commit And Push

Commit current repository work and push it to `origin/main`.

## Workflow

1. Inspect repository state:

```bash
git status
git diff --stat
git log --oneline -3
```

If there are no staged or unstaged changes, report `没有需要提交的内容` and stop.

2. Stage modified and deleted tracked files:

```bash
git add -u
```

Stage untracked files only when they are clearly part of the current work, such as new files under `frontend/src/`, `backend/`, or another relevant source directory. Do not stage `.env`, generated build output, private credentials, local session stores, or unrelated untracked files.

3. Compose the commit message.

Use the user-provided message if present. Otherwise inspect the staged diff and write a concise conventional commit message:

- Format the subject as `<type>: <subject>`, such as `fix:`, `feat:`, `refactor:`, or `chore:`.
- Keep the subject at 72 characters or fewer.
- Add a short body with 2-4 bullet points if the change spans multiple files or concerns.

Always append:

```text
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

4. Commit with the composed message.

Use a non-interactive command, for example:

```bash
git commit -m "<subject>" -m "<body>"
```

5. Push:

```bash
git push origin main
```

Print the resulting commit hash and confirm whether the push succeeded.
