# Recording a nanoflow demo

A throwaway **Acme Shop** repo, four worktrees in different states, dev servers running on their slot
ports, and a **fake GitHub** behind it: issues, a board, PRs and CI that goes from pending to green.
Everything on screen is made up (the paths, the git author, the org, the repo), so you can record and
share it without blurring anything.

## Set up

```bash
npm run build --prefix cli          # or: npm i -g @nanosite/nanoflow
node demo/setup.mjs                 # builds C:\demo (Windows) or /tmp/demo; --dir <path> to choose, --force to rebuild
node demo/launch.mjs                # Claude Code in C:\demo\shop, with this checkout's plugin and the fake GitHub
```

The first launch asks you to trust the folder. Say yes, then run `/nanoflow` if the pane isn't open yet;
it docks by itself in a terminal 144 columns wide or more.

What you start with:

| Worktree | Slot | State |
|---|---|---|
| `shop` (main) | 0 | dev servers running |
| `shop-12-apple-pay` | 1 | PR #18, CI green, dev servers running |
| `shop-14-orders-csv` | 2 | PR #19, CI red (a Playwright test) |
| `shop-15-cart-rounding` | 3 | in progress, 2 files changed, no PR yet |
| `shop-9-product-search` | 4 | PR #17 merged: ready to tear down |

The board has **#21 Dark mode for the storefront** and **#22 Email receipts after purchase** in Ready, to
pick up on camera.

## Before you hit record

- **Your account.** Claude Code's header shows who's logged in. Crop the top line, or record with a
  separate login: `CLAUDE_CONFIG_DIR=C:\demo\.claude-home node demo/launch.mjs`, then log in to a demo account.
- **Your terminal.** Use a fresh profile with no custom prompt (the demo's own paths are neutral already).
  Make it at least 144 columns wide so the pane docks next to the chat.
- **Timing.** New CI runs stay pending for 25 seconds. Set `FAKE_GITHUB_CI_SECONDS=8` before
  `launch.mjs` for snappier takes.

## Shot list

Type the prompts in the Claude Code session. Each one fires real nanoflow toasts and moves the pane.

1. **The overview.** Hold on the pane: five worktrees, each with its ticket, board column, PR, CI and ports;
   🚀 on the running ones; the 🧹 ready-to-tear-down count. Switch to the 🎫 Tickets tab and back.
2. **Pick up a ticket.**
   > Start ticket 21 with nf task start 21

   A toast, a new card on slot 5, #21 moves to In progress, and the terminal tab and session are renamed
   `#21 · feat/21-dark-mode-storefront · dark mode storefront`. The card is framed: **📍 THIS SESSION**.
3. **Build and run it.**
   > Add a dark.css with a dark color scheme, commit it, then nf up --bg

   The commit shows on the card (↑1), the dev servers come up with their links (web :4150).
4. **Checks.**
   > nf check

   Three green lines, one toast.
5. **Open the PR.**
   > nf pr create, then nf ci --watch

   Toast "PR opened", #21 moves to In review, the card shows PR #24 with 🟡 CI, then ✅ and a "CI green" toast.
6. **Red CI, explained.** *(optional)*
   > Why is CI red on PR 19? nf ci 19 --failed-log

   The failing Playwright step, in a few lines.
7. **Merge and tear down.** From a second terminal:

   ```bash
   node demo/director.mjs merge 24
   ```

   Press 🔄 Refresh in the pane: PR merged, #21 to Done, the 🧹 nudge. Then press **Teardown** on the card
   (or `nf wt remove 21-dark-mode-storefront --delete-branch`) and the card goes away.

## Directing

`node demo/director.mjs <command>` changes the fake GitHub from outside the session. The pane picks it up
on its next GitHub poll (every 60 s in the demo), or immediately when you press 🔄 Refresh.

| Command | Effect |
|---|---|
| `ci <pr> pass\|fail\|auto` | set a PR's CI (`auto` = pending, then green) |
| `merge <pr>` | merge it; its ticket closes and moves to Done |
| `status <issue> "<column>"` | move a ticket: Backlog, Ready, In progress, In review, Done |
| `ticket "<title>"` | add a Ready ticket |
| `show` | print the whole state |

Start over any time with `node demo/setup.mjs --force`.

## How it works

`launch.mjs` starts `claude --plugin-dir <this repo>` in the demo repo with `NANOFLOW_GH` pointing at
`fake-github.mjs`, and puts `nf` / `nanoflow` shims first on `PATH`. Every `gh` call nanoflow makes, from the
CLI or from the pane, goes to the fake instead, which keeps its state in `<dir>/github.json`. The dev servers
and git (worktrees, commits, pushes to a local bare `origin.git`) are real.
