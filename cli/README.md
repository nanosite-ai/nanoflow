# @nanosite/nanoflow

**Never lose yourself in ten worktrees.** The nanoflow CLI, by [nanosite.ai](https://nanosite.ai).

One deterministic command per dev ritual: ticket → git worktree on its own ports → checks → PR → CI →
teardown. Built for coding agents: `--json` on everything, `--dry` before any write, never blocks on a prompt.

```bash
npm install -g @nanosite/nanoflow     # gives you `nanoflow` and the short `nf`
nf init --board <org>/<project-number>
nf task start 712                     # issue → In progress → worktree on a free port slot → titles → comment
nf up --bg                            # the app on this worktree's ports, waits until it answers
nf check                              # your checks, one line each, only failures print
nf pr create --shots before.png after.png
nf ci --watch --failed-log
nf wt clean                           # tear down merged worktrees (asks first)
```

It pairs with the **nanoflow Claude Code plugin**, a live dashboard of every worktree, ticket, PR and CI
run, with toasts and a progress status line:

```
/plugin install nanoflow --marketplace nanosite-ai/nanoflow
```

Docs, configuration and the full command reference: **https://github.com/nanosite-ai/nanoflow**

MIT © [nanosite.ai](https://nanosite.ai)
