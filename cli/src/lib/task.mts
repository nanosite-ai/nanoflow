// The current task, read from the branch (its ticket key) and the base title stored in the branch's git
// description, and the one step every lifecycle transition shares: title + board Status.
import type { Status } from "./config.mjs";
import { setBoardStatus } from "./gh.mjs";
import { jiraClient } from "./jira.mjs";
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

/** PR opened / merged: `· PR #n [✓]` on the titles, and the ticket moved. Returns the title and what moved. */
export const advanceTask = async (t: CurrentTask, pr: number, status: Status, merged = false): Promise<{ title: string; note: string }> => {
  const title = withPr(t.base, pr, merged);
  applyTitles(t.repo.config, title);
  return { title, note: await moveTicket(t.repo, t.ticket, status) };
};

/**
 * Move a ticket to a lifecycle step: its GitHub board column, or its Jira workflow status. Returns what
 * happened in words. A Jira that can't be reached or has no such transition is reported, not thrown: by then
 * the PR (or the worktree) exists, and the task goes on.
 */
export const moveTicket = async (repo: RepoContext, ticket: string, status: Status): Promise<string> => {
  if (repo.config.ticket.tracker === "github") {
    setBoardStatus(repo, Number(ticket), status);
    return boardNote(repo, ticket, status);
  }
  const { client, reason } = await jiraClient(repo.config);
  if (!client) return `${ticket}: not moved in Jira (${reason})`;
  try {
    return (await client.moveTo(ticket, status)).note;
  } catch (err) {
    return `${ticket}: not moved in Jira (${(err as Error).message})`;
  }
};

/** What happened on the board, by the repo's own column name; honest when there is no board. */
export const boardNote = (repo: RepoContext, ticket: string, status: Status): string => {
  const b = repo.config.github.board;
  const ref = ticketRef(repo.config, ticket);
  return b ? `${ref} → ${b.statuses[status]}` : `${ref}: no board configured, nothing to move`;
};
