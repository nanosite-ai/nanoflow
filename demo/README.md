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

- Crop Claude Code's top line: it shows who's logged in.
- Make the terminal at least 144 columns wide, so the pane sits beside the chat.
- Open a second terminal in this folder, for the merge.

## Shot list (15–20 s after editing)

Record each beat, then cut the waiting. In Claude Code, type only the quoted text.

| | You do | On screen |
|---|---|---|
| 1 | Nothing. Hold on the pane for 2 s | Five worktrees with their tickets, PRs, CI and ports |
| 2 | Type **"pick up the dark mode ticket"** | A toast; a new card framed **📍 THIS SESSION**; the tab renamed to the ticket |
| 3 | Type **"add a dark theme and open a PR"** | Checks green, "PR opened", the card's CI 🟡 then ✅ |
| 4 | In the second terminal: `node demo/director.mjs merge 24`. Then press 🔄 Refresh, then **Teardown** on the card | PR merged, ticket Done, the card goes away |

Re-take: `node demo/setup.mjs --force`.

## Directing

`node demo/director.mjs <command>` changes the fake GitHub from outside the session. The pane picks it up
on its next GitHub poll (every 60 s in the demo), or immediately when you press 🔄 Refresh.

| Command | Effect |
|---|---|
| `ci <pr> pass\|fail\|auto` | set a PR's CI (`auto` = pending for 8 s, then green; `FAKE_GITHUB_CI_SECONDS` changes it) |
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
