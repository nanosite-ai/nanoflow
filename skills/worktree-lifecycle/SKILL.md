---
name: worktree-lifecycle
description: Run every task as ticket → its own git worktree + branch on its own ports → PR → merge → teardown, with nanoflow. Use when starting, continuing, opening a PR for, or finishing any code task in a repo that has .claude/nanoflow.json or the nanoflow CLI.
---

# Worktree lifecycle

Every task gets **its own ticket, git worktree, branch and PR**. The main checkout stays on the main branch,
so several tasks (and several agent sessions) can run side by side, each on its own ports, sharing one
database and one set of secrets. `nanoflow` (alias `nf`) does each step as one command, so you never
hand-roll a `gh`/`git` sequence.

## 1. Kick off: before reading or editing code

```bash
nf task start <issue#>                 # claim an existing issue
nf task start --new "<plain title>"    # or create it first (--type bug, --definition "…")
```

One command: issue → board **In progress** → worktree `../<repo>-<ticket>-<slug>` on branch
`feat/<ticket>-<slug>`, on the next free port slot → session + terminal title `#<ticket> · <branch> · <short>`
→ an opening comment on the issue. Then `cd` into the printed worktree and do **all** the work there.

Never edit in the main checkout, and never commit to the main branch.

## 2. Work

| Need | Command |
|---|---|
| This worktree's ports and URLs | `nf env` |
| Start the app on those ports, wait until it answers | `nf up --bg` |
| Is it up? Its logs? Stop it | `nf status`, `nf logs <service> --grep error`, `nf kill` |
| Run the repo's checks (one line each; only failures print) | `nf check` / `nf check typecheck test` |
| Every worktree, its ticket, PR and CI, at a glance | `nf flow` |

Commit with Conventional Commits (`feat(scope): subject`). Commit to the task branch only.

## 3. Open the PR

```bash
nf check
nf pr create --body-file pr.md [--shots before.png after.png]
```

It pushes, opens the PR with a valid title (`type(scope): subject (#N)`) and `Closes #N`, attaches the
screenshots, sets the board to **In review** and adds `· PR #n` to the title. Then:

```bash
nf ci --watch --failed-log     # wait for CI without a poll loop; read only the failing steps
nf pr comments                 # unresolved review threads; reply with --reply <id> --body "…"
```

## 4. Merged

```bash
nf task done      # board → Done, title gets ✓
```

## 5. Teardown: always ask first

A merged (or abandoned) worktree costs disk, holds a port slot, and piles up. Teardown deletes things, so
**ask the user every time**: *"PR #N is merged. Tear down `<worktree>` (deletes the dir + local branch)?"*
Never on a general "done", never for a worktree with an open PR or unpushed work.

After a yes, from the **main checkout**:

```bash
nf wt remove <name> --delete-branch    # one worktree; stops its processes first
nf wt clean --yes                      # every worktree whose PR is merged/closed
```

`remove` refuses uncommitted or unpushed work unless `--force`. Then do what the CLI can't:

- close any browser you opened for verification (Playwright MCP: `browser_close`);
- delete the screenshots and recordings you saved locally (only your own files).

## Ground rules

- `--dry` first for anything that writes; `--yes` only after the user approved.
- `--json` when you need to parse a result.
- If a ritual has no command, run the raw `git`/`gh` once, then suggest adding a command.

<sub>Part of [nanoflow](https://github.com/nanosite-ai/nanoflow) by [nanosite.ai](https://nanosite.ai).</sub>
