// The current task, read from the branch (its ticket number) and the base title stored in the branch's git
// description, and the one step every lifecycle transition shares: title + board Status.
import type { Status } from "./config.mjs";
import { setBoardStatus } from "./gh.mjs";
import { run, tryRun } from "./proc.mjs";
import { requireRepo, type RepoContext } from "./repo.mjs";
import { applyTitles, baseTitle, withPr } from "./titles.mjs";
import { ticketOf } from "./worktree.mjs";

export interface CurrentTask {
  repo: RepoContext;
  branch: string;
  ticket: number;
  base: string;
}

const descriptionKey = (branch: string): string => `branch.${branch}.description`;

export const ticketOfBranch = (repo: RepoContext, branch = repo.branch): number => {
  const n = ticketOf(repo.config, branch);
  if (n === null) throw new Error(`Branch "${branch}" carries no ticket number (pattern ${repo.config.ticket.branchPattern}). Run this from the task's worktree.`);
  return n;
};

/** Persist the base title on the branch, where `task pr` / `task done` / `title` read it back. */
export const storeBaseTitle = (cwd: string, branch: string, base: string): void => {
  run("git", ["config", descriptionKey(branch), base], { cwd });
};

export const currentTask = (cwd = process.cwd()): CurrentTask => {
  const repo = requireRepo(cwd);
  const ticket = ticketOfBranch(repo);
  const stored = tryRun("git", ["config", "--get", descriptionKey(repo.branch)], { cwd: repo.checkoutRoot });
  const base = stored || baseTitle(repo.config, ticket, repo.branch, repo.branch.replace(/^.*?\d+-/, "").replace(/-/g, " "));
  return { repo, branch: repo.branch, ticket, base };
};

/** PR opened / merged: `· PR #n [✓]` on the titles, and the board Status. */
export const advanceTask = (t: CurrentTask, pr: number, status: Status, merged = false): string => {
  const title = withPr(t.base, pr, merged);
  applyTitles(t.repo.config, title);
  setBoardStatus(t.repo, t.ticket, status);
  return title;
};

/** What happened on the board, by the repo's own column name; honest when there is no board. */
export const boardNote = (repo: RepoContext, ticket: number, status: Status): string => {
  const b = repo.config.github.board;
  return b ? `#${ticket} → ${b.statuses[status]}` : `#${ticket}: no board configured, nothing to move`;
};
