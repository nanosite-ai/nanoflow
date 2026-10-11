// The current task, read from the branch (its ticket key) and the base title stored in the branch's git
// description, and the one step every lifecycle transition shares: title + board Status.
import type { Status } from "./config.mjs";
import { setBoardStatus } from "./gh.mjs";
import { run, tryRun } from "./proc.mjs";
import { requireRepo, type RepoContext } from "./repo.mjs";
import { ticketOf, ticketRef } from "./tickets.mjs";
import { applyTitles, baseTitle, withPr } from "./titles.mjs";

export interface CurrentTask {
  repo: RepoContext;
  branch: string;
  /** The ticket key: "712", or "ED-712" in another tracker. */
  ticket: string;
  base: string;
}

const descriptionKey = (branch: string): string => `branch.${branch}.description`;

export const ticketOfBranch = (repo: RepoContext, branch = repo.branch): string => {
  const key = ticketOf(repo.config, branch);
  if (key === null) throw new Error(`Branch "${branch}" carries no ticket key (pattern ${repo.config.ticket.branchPattern}). Run this from the task's worktree.`);
  return key;
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
  if (t.repo.config.ticket.github) setBoardStatus(t.repo, Number(t.ticket), status);
  return title;
};

/** What happened on the board, by the repo's own column name; honest when there is no board. */
export const boardNote = (repo: RepoContext, ticket: string, status: Status): string => {
  const b = repo.config.github.board;
  const ref = ticketRef(repo.config, ticket);
  if (!repo.config.ticket.github) return `${ref}: tracked outside GitHub, move it there`;
  return b ? `${ref} → ${b.statuses[status]}` : `${ref}: no board configured, nothing to move`;
};
