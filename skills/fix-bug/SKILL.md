---
name: fix-bug
description: Fix a bug by reproducing it with a failing test first, finding the root cause, and watching the same test pass. Use for any bug report, regression, or "this is broken" request.
---

# Fix a bug: failing test first

A fix you can't show failing-then-passing is a guess. The reproducing test stays in the suite as a
permanent guard.

1. **Ticket.** `nf task start --new "<symptom in plain words>" --type bug --definition "<symptom>" --plan "<steps to reproduce>"`
   (or claim the existing issue). Work in the worktree it creates.
2. **Reproduce with a failing test at the lowest layer that shows it.**
   - pure logic → a unit test next to the file;
   - API / database / auth → an integration test;
   - only in the browser (refresh, cookies, navigation, hydration) → an e2e test (Playwright).

   Assert the correct behaviour, run only that test, and watch it **fail**.
3. **Check it fails for the reported reason.** A test that fails for another reason, or passes before any
   change, is testing the wrong thing. Fix the test first.
4. **Name the root cause in one sentence** before editing. Trace the real path and fix the cause, in the
   layer it lives in, not where it surfaced.
5. **Fix it**, minimally.
6. **Watch the same test pass**, unchanged. (nanoflow shows a "now passes" toast when a red check turns green.)
7. **Run the repo's checks**: `nf check`. All green, or it isn't done.
8. **Record it on the ticket**, in this order: Symptom → Reproduction → Root cause (with reasoning) → Fix
   (why it resolves the cause; alternatives considered) → Testing (the guarding test, and how you verified).
   Then `nf pr create`.

If a bug truly can't be reproduced by a test, say so and why before patching, and put the manual
reproduction and verification on the ticket instead. Don't bundle unrelated refactors into a bug fix.

<sub>Part of [nanoflow](https://github.com/nanosite-ai/nanoflow) by [nanosite.ai](https://nanosite.ai).</sub>
