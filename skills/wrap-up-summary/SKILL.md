---
name: wrap-up-summary
description: End a task with a short recap and a structured status footer (worktree, branch, PR, ticket, done, local URL, next steps). Use whenever a task, a PR, or a working session wraps up, or the user says "done", "ship it", or asks where things stand.
---

# Wrap-up summary

End the message with a short recap, then this footer. `nf summary --what "…" --next "…"` prints it from
live state (worktree, branch, PR, ticket, local URL), so the fields are never stale:

```
**[worktree: <dir|none>] [branch: <branch|merged→main>] [PR: #NNN] [ticket: #NNN] [done: yes|no]**
**Local:** <this worktree's app URL>     ← only while the worktree is live
**What we did:** <one short line: the product-level gist, not a file list>
**Shipped:** <version + where>           ← only if something was released or deployed
**Next:** <one line, or a bullet list, most important first>
```

- The status line is always first and bold. PR and ticket are markdown links on `#NNN` (a raw URL inside
  brackets swallows the `]`).
- Once the PR is merged and the worktree still exists, the first **Next** item is always the teardown
  question: *"Tear down `<worktree>`? (deletes the dir + local branch)"*. Remove it only after the user
  says yes.
- Omit **Local** after teardown, and **Shipped** when nothing was released.

<sub>Part of [nanoflow](https://github.com/nanosite-ai/nanoflow) by [nanosite.ai](https://nanosite.ai).</sub>
