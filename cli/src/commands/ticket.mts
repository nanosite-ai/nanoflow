import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { fillTemplate, STATUS, STATUSES, type Status } from "../lib/config.mjs";
import { createIssue, issueUrl, linkSubIssue, setBoardStatus, boardItems } from "../lib/gh.mjs";
import { dryRun, parseIssueNumber } from "../lib/globals.mjs";
import { c, info, result, success } from "../lib/output.mjs";
import { requireRepo, type RepoContext } from "../lib/repo.mjs";

export interface NewTicketOpts {
  type?: string;
  area?: string;
  body?: string;
  bodyFile?: string;
  definition?: string;
  plan?: string;
  testPlan?: string;
  parent?: string;
  status?: string;
}

/** "In Progress" / "in_review" / "done" → a Status. */
export const parseStatus = (raw: string): Status => {
  const s = raw.toLowerCase().replace(/[\s_]+/g, "-") as Status;
  if (!STATUSES.includes(s)) throw new Error(`Unknown status "${raw}". Use one of: ${STATUSES.join(", ")}.`);
  return s;
};

const BUG = "bug";

/** A body in the repo's section order: given sections filled in, the rest as _TBD_. */
export const renderTicketBody = (sections: readonly string[], filled: Record<string, string | undefined>, parent?: number): string => {
  const parts = parent ? [`Part of #${parent}.`] : [];
  for (const name of sections) parts.push(`### ${name}\n${filled[name]?.trim() || "_TBD_"}`);
  return `${parts.join("\n\n")}\n`;
};

const bodyFrom = (repo: RepoContext, type: string, opts: NewTicketOpts): string => {
  if (opts.bodyFile) return readFileSync(opts.bodyFile, "utf8");
  if (opts.body) return opts.body;
  // Flags map onto the sections by position: first = definition/symptom, second = plan/reproduction, …
  const sections = type === BUG ? repo.config.ticket.sections.bug : repo.config.ticket.sections.ticket;
  const values = [opts.definition, opts.plan, opts.testPlan];
  const filled = Object.fromEntries(sections.map((name, i) => [name, values[i]]));
  return renderTicketBody(sections, filled, opts.parent ? parseIssueNumber(opts.parent) : undefined);
};

const labelsFor = (repo: RepoContext, type: string, area?: string): string[] => {
  const { labels } = repo.config.ticket;
  return [labels.type ? fillTemplate(labels.type, { type }) : "", area && labels.area ? fillTemplate(labels.area, { area }) : ""].filter(Boolean);
};

export interface CreatedTicket {
  number: number;
  url: string;
  title: string;
  status: Status;
}

/** Create the issue, label it, link it under --parent, and set its board Status. Shared with `task start`. */
export const createTicket = (repo: RepoContext, title: string, opts: NewTicketOpts, defaultStatus: Status): CreatedTicket => {
  const type = opts.type ?? repo.config.ticket.types[0];
  if (!repo.config.ticket.types.includes(type)) throw new Error(`Unknown type "${type}". Use one of: ${repo.config.ticket.types.join(", ")}.`);
  const status = opts.status ? parseStatus(opts.status) : defaultStatus;
  const number = createIssue(repo, { title, body: bodyFrom(repo, type, opts), labels: labelsFor(repo, type, opts.area) });
  if (opts.parent) linkSubIssue(repo, parseIssueNumber(opts.parent), number);
  setBoardStatus(repo, number, status);
  return { number, url: issueUrl(repo, number), title, status };
};

export const addTicketOptions = (cmd: Command): Command =>
  cmd
    .option("--type <type>", "issue type (ticket.types in nanoflow.json; default: the first one)")
    .option("--area <area>", "area label, through ticket.labels.area")
    .option("--definition <text>", "first body section (Definition, or Symptom for bugs)")
    .option("--plan <text>", "second body section (Implementation plan, or Reproduction for bugs)")
    .option("--test-plan <text>", "third body section")
    .option("--body <markdown>", "full body, verbatim (skips the sections)")
    .option("--body-file <path>", "full body from a file, verbatim")
    .option("--parent <issue>", "link as a sub-issue of this epic");

export const registerTicket = (program: Command): void => {
  const ticket = program.command("ticket").description("GitHub issues in your ticket anatomy");

  addTicketOptions(ticket.command("new").description("create an issue (labels + board Status) without starting work on it").argument("<title>", "plain descriptive title"))
    .option("--status <status>", `board Status: ${STATUSES.join(" | ")}`, STATUS.ready)
    .addHelpText("after", '\nExamples:\n  nanoflow ticket new "csv export for orders" --definition "…"\n  nf ticket new "checkout 500 on empty cart" --type bug --status backlog\n  nf ticket new "phase 2" --parent 650 --body-file plan.md')
    .action((title: string, opts: NewTicketOpts, cmd: Command) => {
      const repo = requireRepo();
      if (dryRun(cmd, `would create "${title}" → ${opts.status}`)) return;
      const created = createTicket(repo, title, opts, STATUS.ready);
      result(created, () => success(`#${created.number} ${created.title} → ${created.status}  ${created.url}`));
    });
};

export const registerBoard = (program: Command): void => {
  const board = program.command("board").description("the GitHub Project board (github.board in nanoflow.json)");

  board
    .command("set")
    .description("set an issue's Status (adds it to the board if missing)")
    .argument("<issue>", "issue number, e.g. 651 or #651")
    .argument("<status>", STATUSES.join(" | "))
    .addHelpText("after", "\nExamples:\n  nf board set 651 in-progress\n  nf board set 651 done --dry")
    .action((issueArg: string, statusArg: string, _opts, cmd: Command) => {
      const repo = requireRepo();
      const n = parseIssueNumber(issueArg);
      const status = parseStatus(statusArg);
      if (!repo.config.github.board) throw new Error('No board configured. Add "github": { "board": { "owner": "<org>", "number": <n> } } to .claude/nanoflow.json.');
      const name = repo.config.github.board.statuses[status];
      if (dryRun(cmd, `would set #${n} → ${name}`)) return;
      setBoardStatus(repo, n, status);
      result({ issue: n, status: name }, () => success(`#${n} → ${name}`));
    });

  board
    .command("list")
    .description("board issues in a column (default: ready, i.e. up for pickup)")
    .argument("[status]", STATUSES.join(" | "), STATUS.ready)
    .addHelpText("after", "\nExamples:\n  nf board list\n  nf board list in-review --json")
    .action((statusArg: string) => {
      const repo = requireRepo();
      const b = repo.config.github.board;
      if (!b) throw new Error("No board configured (github.board in .claude/nanoflow.json).");
      const items = boardItems(repo, [b.statuses[parseStatus(statusArg)]]);
      result(items, () => {
        if (!items.length) info(c.dim("(none)"));
        for (const item of items) info(`#${item.number}  ${item.title}  ${c.dim(item.url)}`);
      });
    });
};
