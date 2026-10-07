---
name: pr-screenshots
description: Verify a visual change in a real browser with the Playwright MCP and attach before/after screenshots to its PR. Use when a change affects anything you can see (UI, pages, emails, charts) and before opening or updating its PR.
---

# Verify in the browser, screenshot the PR

Reviewers should judge a visual change without checking the branch out. Unit tests don't show what a user
sees, so verify live.

1. **Run this worktree's app on its own ports**: `nf up --bg`, then `nf env` for the URL (each worktree has
   its own, so you never test another task's code by mistake).
2. **Before**: capture the current behaviour from the main checkout's URL (slot 0), or from the deployed
   site.
3. **After**: open this worktree's URL with the Playwright MCP (`browser_navigate`), drive the flow
   (`browser_snapshot` to read the page, then click/type by role and text, not CSS selectors), and take
   screenshots (`browser_take_screenshot`) of each state the change touches. Cover each theme or viewport
   the change affects. Name files for what they show: `before-checkout.png`, `after-checkout-mobile.png`.
4. **Attach**:
   ```bash
   nf pr create --body-file pr.md --shots before-checkout.png after-checkout.png   # new PR
   nf shots <pr#> after-checkout-v2.png --attach                                  # existing PR
   ```
   The images go to one orphan branch (`assets/pr-screenshots`, a `pr-<n>-<slug>/` folder per PR), so
   they render inline, even on a private repo, and never enter the merge diff.
5. **Clean up**: close the browser (`browser_close`) and delete the screenshot files you saved locally
   (only your own; other sessions may share the folder).

Skip screenshots only for changes with nothing to see (pure backend, config, docs) or when the surface
genuinely can't be rendered locally; say which in the PR.

<sub>Part of [nanoflow](https://github.com/nanosite-ai/nanoflow) by [nanosite.ai](https://nanosite.ai).</sub>
