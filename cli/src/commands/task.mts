import type { Command } from "commander";
import { STATUS } from "../lib/config.mjs";
import { commentIssue, prForBranch, PR_STATE, setBoardStatus, viewIssue } from "../lib/gh.mjs";
import { dryRun, parseIssueNumber } from "../lib/globals.mjs";
import { c, info, result, success } from "../lib/output.mjs";
import { requireRepo, type RepoContext } from "../lib/repo.mjs";
import { advanceTask, currentTask, storeBaseTitle, ticketOfBranch } from "../lib/task.mjs";
import { applyTitles, baseTitle, withPr } from "../lib/titles.mjs";
import { branchFor, createWorktree, slugify } from "../lib/worktree.mjs";
import { addTicketOptions, createTicket, type NewTicketOpts } from "./ticket.mjs";

interface StartOpts extends NewTicketOpts {
  new?: string;
  slug?: string;
  title?: string;
  comment?: string;
  install?: boolean;
}

/** 2–4 lowercase words for the session/terminal title. */
const shortTitleOf = (title: string): string => slugify(title, 4).replace(/-/g, " ");

/** Create or claim the issue and set it In progress. */
const claimIssue = (repo: RepoContext, issueArg: string | undefined, opts: StartOpts): { number: number; title: string } => {
  if (opts.new) {
    const created = createTicket(repo, opts.new, opts, STATUS.inProgress);
    success(`created #${created.number} ${created.url}`);
    return { number: created.number, title: created.title };
  }
  const number = parseIssueNumber(issueArg as string);
  const issue = viewIssue(repo, number);
  if (issue.state !== "OPEN") throw new Error(`#${number} is ${issue.state}; reopen it or pick another.`);
  setBoardStatus(repo, number, STATUS.inProgress);
  return { number, title: issue.title };
};

export const registerTask = (program: Command): void => {
  const task = program.command("task").description("the ticket lifecycle: kickoff → PR → merged, keeping the board and the session/terminal title in step");

  addTicketOptions(
    task
      .command("start")
      .description("kick off a task: issue → board In progress → worktree on its own ports → session/terminal title → opening comment")
      .argument("[issue]", "existing issue number to claim (or --new)"),
  )
    .option("--new <title>", "create the issue first (takes the ticket options)")
    .option("--slug <slug>", "worktree/branch slug (default: from the issue title)")
    .option("--title <short>", "short session title, 2–4 words (default: from the issue title)")
    .option("--comment <text>", "opening comment on the issue (default: names the branch)")
    .option("--no-install", "skip the worktree's install step")
    .addHelpText("after", ["", "Examples:", "  nanoflow task start 651", '  nf task start 651 --slug csv-export --title "csv export"', '  nf task start --new "lease expires mid-post" --type bug'].join("\n"))
    .action((issueArg: string | undefined, opts: StartOpts, cmd: Command) => {
      const repo = requireRepo();
      if (!issueArg && !opts.new) throw new Error('Pass an issue number, or --new "<title>" to create one.');
      if (issueArg && opts.new) throw new Error("Pass either an issue number or --new, not both.");
      if (dryRun(cmd, `would ${opts.new ? `create "${opts.new}"` : `claim #${issueArg}`}, set In progress, create the worktree, set titles, comment`)) return;

      const issue = claimIssue(repo, issueArg, opts);
      if (repo.config.github.board) success(`#${issue.number} → ${repo.config.github.board.statuses[STATUS.inProgress]}`);

      const feature = `${issue.number}-${opts.slug ?? slugify(issue.title)}`;
      const branch = branchFor(repo, feature);
      const worktree = createWorktree(repo, feature, { install: opts.install });

      const base = baseTitle(repo.config, issue.number, branch, opts.title ?? shortTitleOf(issue.title));
      storeBaseTitle(repo.mainRoot, branch, base);
      applyTitles(repo.config, base);

      commentIssue(repo, issue.number, opts.comment ?? `Starting work on \`${branch}\`.`);
      result({ issue: issue.number, branch, worktree, title: base }, () => success(`ready: cd "${worktree}"`));
    });

  task
    .command("pr")
    .description("PR is open: title gets `· PR #n`, board → In review (nanoflow pr create does this for you)")
    .argument("<pr>", "PR number")
    .addHelpText("after", "\nExamples:\n  nf task pr 652")
    .action((prArg: string, _opts, cmd: Command) => {
      const pr = parseIssueNumber(prArg);
      const t = currentTask();
      if (dryRun(cmd, `would add "· PR #${pr}" to the title and set #${t.ticket} → In review`)) return;
      const title = advanceTask(t, pr, STATUS.inReview);
      result({ issue: t.ticket, pr, title }, () => success(`#${t.ticket} → In review`));
    });

  task
    .command("done")
    .alias("merged")
    .description("PR merged: title gets ✓, board → Done; reminds you to tear the worktree down")
    .addHelpText("after", "\nExamples:\n  nf task done")
    .action((_opts, cmd: Command) => {
      const t = currentTask();
      const pr = prForBranch(t.repo, t.branch, PR_STATE.merged);
      if (!pr) throw new Error(`No merged PR found for ${t.branch}.`);
      if (dryRun(cmd, `would add "· PR #${pr.number} ✓" to the title and set #${t.ticket} → Done`)) return;
      const title = advanceTask(t, pr.number, STATUS.done, true);
      result({ issue: t.ticket, pr: pr.number, title }, () => {
        success(`#${t.ticket} → Done`);
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
