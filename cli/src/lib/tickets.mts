// Ticket keys: `712` for a GitHub issue, `ED-712` for a Jira (or any other tracker's) ticket. A key is
// always a string here; GitHub calls turn it back into the issue number.
import type { FlowConfig } from "./config.mjs";
import { issueUrl } from "./gh.mjs";
import { parseIssueNumber } from "./globals.mjs";
import type { RepoContext } from "./repo.mjs";

const keyRegex = (config: FlowConfig): RegExp => new RegExp(`^(?:${config.ticket.keyPattern})$`);

/** The ticket key in a branch (or worktree name), per ticket.branchPattern. */
export const ticketOf = (config: FlowConfig, ...candidates: (string | undefined | null)[]): string | null => {
  const re = new RegExp(config.ticket.branchPattern);
  for (const c of candidates) {
    const key = re.exec(c ?? "")?.[1];
    if (!key) continue;
    if (!config.ticket.github) return key;
    const n = Number(key);
    if (Number.isInteger(n) && n > 0) return String(n);
  }
  return null;
};

/** A key typed by a person: `#712` / `712` for GitHub, `ED-712` (any case) for another tracker. */
export const parseTicketKey = (config: FlowConfig, raw: string): string => {
  if (config.ticket.github) return String(parseIssueNumber(raw));
  const re = keyRegex(config);
  const key = [raw.trim(), raw.trim().toUpperCase()].find((k) => re.test(k));
  if (!key) throw new Error(`"${raw}" is not a ticket key (ticket.keyPattern ${config.ticket.keyPattern}).`);
  return key;
};

/** How a ticket is written in titles and messages: `#712` for a GitHub issue, else the key itself. */
export const ticketRef = (config: FlowConfig, key: string): string => (config.ticket.github ? `#${key}` : key);

/** A key in --json output: the issue number for GitHub (as before), else the key. */
export const ticketJson = (config: FlowConfig, key: string): number | string => (config.ticket.github ? Number(key) : key);

/** The number inside a key, for the provider contract's `number`: 712 for `ED-712`, 0 when there is none. */
export const ticketNumber = (key: string): number => Number(/(\d+)(?!.*\d)/.exec(key)?.[1] ?? 0);

/** The ticket's page: ticket.urlTemplate, else the GitHub issue, else none. */
export const ticketUrl = (repo: RepoContext, key: string): string => {
  const template = repo.config.ticket.urlTemplate;
  if (template) return template.replace("{ticket}", key);
  return repo.config.ticket.github ? issueUrl(repo, Number(key)) : "";
};

/** Fail with the reason when the repo's tickets aren't GitHub issues. */
export const requireGithubTickets = (config: FlowConfig, what: string): void => {
  if (!config.ticket.github) {
    throw new Error(`${what} works on GitHub issues, and this repo's tickets live elsewhere (ticket.github: false). Do it in your tracker.`);
  }
};
