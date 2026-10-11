import type { Command } from "commander";
import { STATUS } from "../lib/config.mjs";
import { commentIssue, prForBranch, PR_STATE, setBoardStatus, viewIssue } from "../lib/gh.mjs";
import { dryRun, parseIssueNumber } from "../lib/globals.mjs";
import { jiraClient } from "../lib/jira.mjs";
import { c, info, result, success, warn } from "../lib/output.mjs";
import { requireRepo, type RepoContext } from "../lib/repo.mjs";
import { advanceTask, boardNote, currentTask, moveTicket, storeBaseTitle, ticketOfBranch } from "../lib/task.mjs";
import { parseTicketKey, ticketJson, ticketRef } from "../lib/tickets.mjs";
import { applyTitles, baseTitle, withPr } from "../lib/titles.mjs";
import { branchFor, createWorktree, slugify } from "../lib/worktree.mjs";
import { addTicketOptions, createJiraTicket, createTicket, type NewTicketOpts } from "./ticket.mjs";

interface StartOpts extends NewTicketOpts {
  new?: string;
  slug?: string;
  title?: string;
  comment?: string;
  install?: boolean;
}

/** 2–3 lowercase words for the session/terminal title. */
const shortTitleOf = (title: string): string => slugify(title, 3).replace(/-/g, " ");

/**
 * Jira: read (or create) the ticket and move it to In progress. Not logged in, nanoflow can't read it, so the
 * title comes from --title / --slug and the move is left to the person.
 */
const claimJiraTicket = async (repo: RepoContext, ticketArg: string | undefined, opts: StartOpts, type: string): Promise<{ key: string; title: string }> => {
  const { client, reason } = await jiraClient(repo.config);
  if (!client) {
    if (opts.new) throw new Error(`Creating a Jira ticket needs Jira access: ${reason}.`);
    const key = parseTicketKey(repo.config, ticketArg as string);
    const title = opts.title ?? opts.slug?.replace(/-/g, " ");
    if (!title) throw new Error(`Can't read ${key} (${reason}). Log in, or pass its title: \`nf task start ${key} --title "<short title>"\`.`);
    warn(`${key}: not read or moved in Jira (${reason})`);
    return { key, title };
  }
  const issue = opts.new
    ? await createJiraTicket(client, repo, opts.new, opts, type)
    : await client.issue(parseTicketKey(repo.config, ticketArg as string));
  if (opts.new) success(`created ${issue.key} ${issue.url}`);
  if (issue.state !== "OPEN") throw new Error(`${issue.key} is ${issue.status}; reopen it or pick another.`);
  return { key: issue.key, title: issue.title };
};

/** Create or claim the ticket and set it In progress. */
const claimTicket = async (repo: RepoContext, ticketArg: string | undefined, opts: StartOpts, type: string): Promise<{ key: string; title: string }> => {
  if (repo.config.ticket.tracker === "jira") return claimJiraTicket(repo, ticketArg, opts, type);
  if (opts.new) {
    const created = createTicket(repo, opts.new, opts, STATUS.inProgress);
    success(`created #${created.number} ${created.url}`);
    return { key: String(created.number), title: created.title };
  }
  const number = parseIssueNumber(ticketArg as string);
  const issue = viewIssue(repo, number);
  if (issue.state !== "OPEN") throw new Error(`#${number} is ${issue.state}; reopen it or pick another.`);
  setBoardStatus(repo, number, STATUS.inProgress);
  return { key: String(number), title: issue.title };
};

export const registerTask = (program: Command): void => {
  const task = program.command("task").description("the ticket lifecycle: kickoff → PR → merged, keeping the board and the session/terminal title in step");

  addTicketOptions(
    task
      .command("start")
      .description("kick off a task: issue → board In progress → worktree on its own ports → session/terminal title → opening comment")
      .argument("[ticket]", "existing issue number to claim (or --new); in Jira, the ticket key, e.g. ED-712"),
  )
    .option("--new <title>", "create the issue first (takes the ticket options)")
    .option("--slug <slug>", "worktree/branch slug (default: from the issue title)")
    .option("--title <short>", "short session title, 2–4 words (default: from the ticket title; required for Jira when not logged in)")
    .option("--comment <text>", "opening comment on the issue (default: names the branch)")
    .option("--no-install", "skip the worktree's install step")
    .addHelpText("after", ["", "Examples:", "  nanoflow task start 651", '  nf task start 651 --slug csv-export --title "csv export"', '  nf task start --new "lease expires mid-post" --type bug', '  nf task start ED-712 --type fix   (ticket.tracker: "jira")'].join("\n"))
    .action(async (issueArg: string | undefined, opts: StartOpts, cmd: Command) => {
      const repo = requireRepo();
      const { config } = repo;
      if (!issueArg && !opts.new) throw new Error('Pass a ticket (issue number or key), or --new "<title>" to create one.');
      if (issueArg && opts.new) throw new Error("Pass either a ticket or --new, not both.");
      const type = opts.type ?? config.ticket.types[0];
      if (!config.ticket.types.includes(type)) throw new Error(`Unknown type "${type}". Use one of: ${config.ticket.types.join(", ")}.`);
      if (dryRun(cmd, `would ${opts.new ? `create "${opts.new}"` : `claim ${issueArg}`}, set In progress, create the worktree, set titles, comment`)) return;

      const ticket = await claimTicket(repo, issueArg, opts, type);
      const jira = config.ticket.tracker === "jira" ? (await jiraClient(config)).client : null;
      const moved = jira ? await moveTicket(repo, ticket.key, STATUS.inProgress) : config.github.board ? boardNote(repo, ticket.key, STATUS.inProgress) : null;
      if (moved) success(moved);

      const feature = `${ticket.key}-${opts.slug ?? slugify(ticket.title)}`;
      const branch = branchFor(repo, feature, type);
      const worktree = createWorktree(repo, feature, { install: opts.install, type });

      const base = baseTitle(config, ticket.key, branch, opts.title ?? shortTitleOf(ticket.title));
      storeBaseTitle(repo.mainRoot, branch, base);
      applyTitles(config, base);

      if (config.ticket.tracker === "github") commentIssue(repo, Number(ticket.key), opts.comment ?? `Starting work on \`${branch}\`.`);
      else if (jira) await jira.comment(ticket.key, opts.comment ?? `Starting work on branch ${branch}.`).catch((err: Error) => warn(`${ticket.key}: no comment (${err.message})`));
      result({ issue: ticketJson(config, ticket.key), branch, worktree, title: base, ticketNote: moved }, () => success(`ready: cd "${worktree}"`));
    });

  task
    .command("pr")
    .description("PR is open: title gets `· PR #n`, board → In review (nanoflow pr create does this for you)")
    .argument("<pr>", "PR number")
    .addHelpText("after", "\nExamples:\n  nf task pr 652")
    .action(async (prArg: string, _opts, cmd: Command) => {
      const pr = parseIssueNumber(prArg);
      const t = currentTask();
      if (dryRun(cmd, `would add "· PR #${pr}" to the title and set ${ticketRef(t.repo.config, t.ticket)} → In review`)) return;
      const { title, note } = await advanceTask(t, pr, STATUS.inReview);
      result({ issue: ticketJson(t.repo.config, t.ticket), pr, title, ticketNote: note }, () => success(note));
    });

  task
    .command("done")
    .alias("merged")
    .description("PR merged: title gets ✓, board → Done; reminds you to tear the worktree down")
    .addHelpText("after", "\nExamples:\n  nf task done")
    .action(async (_opts, cmd: Command) => {
      const t = currentTask();
      const pr = prForBranch(t.repo, t.branch, PR_STATE.merged);
      if (!pr) throw new Error(`No merged PR found for ${t.branch}.`);
      if (dryRun(cmd, `would add "· PR #${pr.number} ✓" to the title and set ${ticketRef(t.repo.config, t.ticket)} → Done`)) return;
      const { title, note } = await advanceTask(t, pr.number, STATUS.done, true);
      result({ issue: ticketJson(t.repo.config, t.ticket), pr: pr.number, title, ticketNote: note }, () => {
        success(note);
        info(c.dim(`next: ask before tearing down this worktree, then from the main checkout: nf wt remove <name> --delete-branch`));
      });
    });
};

export const registerTitle = (program: Command): void => {
  program
    .command("title")
    .description("(re)apply the session + terminal title for the current task branch")
    .option("--set <short>", "store a new short title for this branch, then apply it")
    .option("--pr <n>", "append `· PR #n`")
    .option("--merged", "append ✓ (with --pr)")
    .addHelpText("after", '\nExamples:\n  nf title\n  nf title --set "lease expiry"\n  nf title --pr 652 --merged')
    .action((opts: { set?: string; pr?: string; merged?: boolean }, cmd: Command) => {
      const repo = requireRepo();
      const base = opts.set ? baseTitle(repo.config, ticketOfBranch(repo), repo.branch, opts.set) : currentTask().base;
      const title = opts.pr ? withPr(base, opts.pr.replace(/^#/, ""), opts.merged) : base;
      if (dryRun(cmd, `would set title "${title}"`)) return;
      if (opts.set) storeBaseTitle(repo.checkoutRoot, repo.branch, base);
      applyTitles(repo.config, title);
      result({ title }, () => success("title set"));
    });
};
