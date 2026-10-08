import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { STATUS } from "../lib/config.mjs";
import { bodyLinksTicket, prTitleProblems, titleFromCommits, withTicketRef } from "../lib/conventional.mjs";
import { gh, ghRepo, prField, prForBranch, PR_STATE, repoSlug, setPrBody } from "../lib/gh.mjs";
import { commitsSinceMain, fetchMain } from "../lib/git.mjs";
import { dryRun, parseIssueNumber, tempFile } from "../lib/globals.mjs";
import { c, info, result, success, warn } from "../lib/output.mjs";
import { run, runAnyExit, tail, tryRun } from "../lib/proc.mjs";
import { requireRepo, type RepoContext } from "../lib/repo.mjs";
import { attachShotsToBody, shotRepoPath, shotsFolder, uploadShots } from "../lib/shots.mjs";
import { advanceTask, currentTask } from "../lib/task.mjs";

/** A PR body with the commits as a starting point and the ticket linked. */
export const defaultPrBody = (ticket: number, commits: string[]): string =>
  ["## What & why", "", commits.map((s) => `- ${s}`).join("\n") || "_TBD_", "", "## Ticket", "", `Closes #${ticket}`, "", "## Test plan", "", "_TBD_", ""].join("\n");

/** An explicit PR number, else the current branch's PR. */
const resolvePr = (repo: RepoContext, prArg: string | undefined): number => {
  if (prArg) return parseIssueNumber(prArg);
  const pr = prForBranch(repo, repo.branch, PR_STATE.all);
  if (!pr) throw new Error(`No PR for ${repo.branch}: pass the PR number.`);
  return pr.number;
};

const oneLine = (s: string, max = 240): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

interface ThreadComment {
  id: number;
  author: string;
  body: string;
  url: string;
}
interface ReviewThread {
  isResolved: boolean;
  path: string;
  line: number | null;
  comments: ThreadComment[];
}

const reviewThreads = (repo: RepoContext, pr: number): ReviewThread[] => {
  const [owner, name] = repoSlug(repo).split("/");
  const query = `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){
    reviewThreads(first:100){nodes{isResolved path line comments(first:50){nodes{databaseId body url author{login}}}}}}}}`;
  const raw = gh([
    "api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `repo=${name}`, "-F", `n=${pr}`,
    "--jq", "[.data.repository.pullRequest.reviewThreads.nodes[] | {isResolved, path, line, comments: [.comments.nodes[] | {id: .databaseId, author: .author.login, body, url}]}]",
  ]);
  return JSON.parse(raw || "[]") as ReviewThread[];
};

const conversationComments = (repo: RepoContext, pr: number): ThreadComment[] => {
  const raw = gh(["api", `repos/${repoSlug(repo)}/issues/${pr}/comments`, "--paginate", "--jq", "[.[] | {id, author: .user.login, body, url: .html_url}]"]);
  return raw.split(/\n(?=\[)/).flatMap((page) => JSON.parse(page || "[]") as ThreadComment[]);
};

export const registerPr = (program: Command): void => {
  const pr = program.command("pr").description("pull requests: create with a valid title + linked ticket, read and answer review comments");

  pr.command("create")
    .description("push, open the PR (Conventional title + (#N), Closes #N), attach screenshots, board → In review, title")
    .option("--title <title>", "PR title; ` (#N)` is appended if missing (default: the first feat/fix commit)")
    .option("--body <markdown>", "PR body (Closes #N is appended if missing)")
    .option("--body-file <path>", "PR body from a file")
    .option("--shots <files...>", "screenshots to upload to the screenshots branch and embed")
    .option("--draft", "open as a draft")
    .option("--no-push", "don't push the branch first")
    .addHelpText("after", ["", "Examples:", "  nf pr create", '  nf pr create --title "feat(web): add csv export" --body-file pr.md', "  nf pr create --body-file pr.md --shots before.png after.png"].join("\n"))
    .action((opts: { title?: string; body?: string; bodyFile?: string; shots?: string[]; draft?: boolean; push?: boolean }, cmd: Command) => {
      const t = currentTask();
      const { repo } = t;
      const cwd = repo.checkoutRoot;
      fetchMain(cwd, repo.config.mainBranch);
      const commits = commitsSinceMain(cwd, repo.config.mainBranch);
      const rawTitle = opts.title ?? titleFromCommits(commits) ?? commits[0];
      if (!rawTitle) throw new Error("No commits on this branch to take a title from: pass --title.");
      const title = withTicketRef(rawTitle, t.ticket);
      if (repo.config.pr.conventional) {
        const problems = prTitleProblems(title);
        if (problems.length) throw new Error(`PR title is not a valid Conventional Commit:\n  ${problems.join("\n  ")}\n(pr.conventional: false in nanoflow.json turns this off)`);
      }
      let body = opts.bodyFile ? readFileSync(opts.bodyFile, "utf8") : (opts.body ?? defaultPrBody(t.ticket, commits));
      if (!bodyLinksTicket(body)) body = `${body.trimEnd()}\n\nCloses #${t.ticket}\n`;

      const existing = prForBranch(repo, t.branch, PR_STATE.open);
      if (existing) throw new Error(`This branch already has an open PR: ${existing.url}`);
      const shotsNote = opts.shots?.length ? [`would upload + embed ${opts.shots.length} screenshot(s)`] : [];
      if (dryRun(cmd, `would push ${t.branch} and open: ${title}${opts.draft ? " (draft)" : ""}`, body, ...shotsNote)) return;

      if (opts.push !== false) run("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd });
      const url = ghRepo(repo, ["pr", "create", "--head", t.branch, "--title", title, "--body-file", tempFile("pr.md", body), ...(opts.draft ? ["--draft"] : [])], cwd);
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
      if (!number) throw new Error(`Unexpected gh pr create output: ${url}`);
      success(`opened ${url}`);

      if (opts.shots?.length) {
        const uploaded = uploadShots(repo, { pr: number, branch: t.branch, files: opts.shots });
        setPrBody(repo, number, attachShotsToBody(body, uploaded.map((u) => u.markdown)));
        success(`${uploaded.length} screenshot(s) attached`);
      }
      advanceTask(t, number, STATUS.inReview);
      result({ pr: number, url, title, issue: t.ticket }, () => success(`#${t.ticket} → In review`));
    });

  pr.command("comments")
    .description("unresolved review threads + conversation comments, condensed; reply in a thread or comment")
    .argument("[pr]", "PR number (default: the current branch's PR)")
    .option("--all", "include resolved review threads")
    .option("--reply <commentId>", "reply in the review thread of this comment id (with --body)")
    .option("--comment", "post a top-level PR comment (with --body)")
    .option("--body <text>", "text for --reply / --comment")
    .addHelpText("after", ["", "Examples:", "  nf pr comments", "  nf pr comments 652 --all --json", '  nf pr comments 652 --reply 2451234567 --body "fixed in 1a2b3c"'].join("\n"))
    .action((prArg: string | undefined, opts: { all?: boolean; reply?: string; comment?: boolean; body?: string }, cmd: Command) => {
      const repo = requireRepo();
      const number = resolvePr(repo, prArg);
      if (opts.reply || opts.comment) {
        if (!opts.body) throw new Error("--reply / --comment need --body <text>.");
        if (dryRun(cmd, `would ${opts.reply ? `reply to ${opts.reply}` : "comment"} on #${number}: ${opts.body}`)) return;
        if (opts.reply) gh(["api", "-X", "POST", `repos/${repoSlug(repo)}/pulls/${number}/comments/${opts.reply}/replies`, "-f", `body=${opts.body}`]);
        else ghRepo(repo, ["pr", "comment", String(number), "--body", opts.body]);
        success(opts.reply ? `replied to ${opts.reply}` : `commented on #${number}`);
        return;
      }
      const threads = reviewThreads(repo, number).filter((th) => opts.all || !th.isResolved);
      const conversation = conversationComments(repo, number);
      result({ pr: number, threads, conversation }, () => {
        info(c.bold(`PR #${number}: ${threads.length} ${opts.all ? "" : "unresolved "}review thread(s), ${conversation.length} comment(s)`));
        for (const th of threads) {
          info(`\n${c.cyan(`${th.path}:${th.line ?? "?"}`)}${th.isResolved ? c.dim(" (resolved)") : ""}`);
          for (const cm of th.comments) info(`  ${c.dim(`[${cm.id}]`)} ${c.bold(cm.author)}: ${oneLine(cm.body)}`);
        }
        if (conversation.length) info("");
        for (const cm of conversation) info(`${c.dim(`[${cm.id}]`)} ${c.bold(cm.author)}: ${oneLine(cm.body)}`);
      });
    });
};

export const registerShots = (program: Command): void => {
  program
    .command("shots")
    .description("upload screenshots to the screenshots branch (pr-<n>-<slug>/) and print or --attach the markdown")
    .argument("<pr>", "PR number")
    .argument("<files...>", "png/jpg/gif/webm files")
    .option("--attach", "also add them under the PR body's ## Screenshots section")
    .addHelpText("after", "\nExamples:\n  nf shots 655 before.png after.png\n  nf shots 655 shots/*.png --attach")
    .action((prArg: string, files: string[], opts: { attach?: boolean }, cmd: Command) => {
      const repo = requireRepo();
      const pr = parseIssueNumber(prArg);
      const branch = prField(repo, pr, "headRefName");
      const folder = shotsFolder(pr, branch);
      if (dryRun(cmd, ...files.map((f) => `would upload ${f} → ${repo.config.pr.shotsBranch}/${shotRepoPath(folder, f)}`))) return;
      const uploaded = uploadShots(repo, { pr, branch, files });
      if (opts.attach) setPrBody(repo, pr, attachShotsToBody(prField(repo, pr, "body"), uploaded.map((u) => u.markdown)));
      result(uploaded, () => {
        for (const u of uploaded) info(u.markdown);
        success(`${uploaded.length} file(s) uploaded${opts.attach ? ` and attached to PR #${pr}` : ""}`);
      });
    });
};

// ─── CI ──────────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  workflow: string;
  state: string;
  bucket: string;
  link: string;
}

const POLL_MS = 15_000;

const prChecks = (repo: RepoContext, pr: number): Check[] => {
  // `gh pr checks` exits 1 when a check failed and 8 while some are pending, and still prints the JSON.
  const { stdout } = runAnyExit("gh", ["pr", "checks", String(pr), "--repo", repoSlug(repo), "--json", "name,workflow,state,bucket,link"]);
  if (stdout.startsWith("[")) return JSON.parse(stdout) as Check[];
  if (ghRepo(repo, ["pr", "view", String(pr), "--json", "statusCheckRollup", "--jq", ".statusCheckRollup | length"]) === "0") return [];
  throw new Error(`Could not read checks for PR #${pr}.`);
};

const runIdOf = (link: string): string | null => /\/actions\/runs\/(\d+)/.exec(link)?.[1] ?? null;
const isPending = (checks: Check[]): boolean => checks.some((ch) => ch.bucket === "pending");

const icon = (bucket: string): string => ({ pass: c.ok("✔"), fail: c.err("✖"), pending: c.warn("…") })[bucket] ?? c.dim("-");

export const registerCi = (program: Command): void => {
  program
    .command("ci")
    .description("PR checks: status, --watch until done (no poll loops), the failing jobs' log tails, rerun failed")
    .argument("[pr]", "PR number (default: the current branch's PR)")
    .option("--watch", "wait until no check is pending; exit 1 if any failed")
    .option("--timeout <min>", "give up watching after this many minutes", "30")
    .option("--failed-log", "print the tail of each failed job's log")
    .option("--lines <n>", "log lines per failed job", "60")
    .option("--rerun-failed", "re-run the failed jobs")
    .addHelpText("after", "\nExamples:\n  nf ci\n  nf ci 652 --watch --failed-log\n  nf ci --rerun-failed")
    .action(async (prArg: string | undefined, opts: { watch?: boolean; timeout: string; failedLog?: boolean; lines: string; rerunFailed?: boolean }, cmd: Command) => {
      const repo = requireRepo();
      const pr = resolvePr(repo, prArg);
      let checks = prChecks(repo, pr);
      if (opts.watch) {
        const deadline = Date.now() + Number(opts.timeout) * 60_000;
        while ((checks.length === 0 || isPending(checks)) && Date.now() < deadline) {
          const pending = checks.filter((ch) => ch.bucket === "pending").map((ch) => ch.name);
          info(c.dim(`waiting on ${pending.length ? pending.join(", ") : "checks to start"}…`));
          await sleep(POLL_MS);
          checks = prChecks(repo, pr);
        }
        if (isPending(checks)) warn(`still pending after ${opts.timeout} min`);
      }
      const failed = checks.filter((ch) => ch.bucket === "fail");
      const runIds = [...new Set(failed.map((ch) => runIdOf(ch.link)).filter((id): id is string => Boolean(id)))];
      const slug = repoSlug(repo);
      const logs = Object.fromEntries((opts.failedLog ? runIds : []).map((id) => [id, tail(tryRun("gh", ["run", "view", id, "--repo", slug, "--log-failed"]) ?? "", Number(opts.lines))]));
      const rerun = Boolean(opts.rerunFailed && runIds.length) && !dryRun(cmd, `would re-run failed jobs of run(s) ${runIds.join(", ")}`);
      if (rerun) for (const id of runIds) ghRepo(repo, ["run", "rerun", id, "--failed"]);

      result({ pr, checks, failedRuns: runIds, logs, rerun }, () => {
        info(c.bold(`PR #${pr} checks`));
        if (!checks.length) info(c.dim("  (no checks reported yet)"));
        for (const ch of checks) info(`  ${icon(ch.bucket)} ${ch.workflow ? `${ch.workflow} / ` : ""}${ch.name}  ${c.dim(ch.link)}`);
        for (const [id, log] of Object.entries(logs)) info(`\n${c.bold(`run ${id}, failed steps:`)}\n${log || c.dim("(no failed-step log)")}`);
        if (rerun) info(`re-running failed jobs of ${runIds.join(", ")}`);
      });
      if (failed.length || (opts.watch && isPending(checks))) process.exitCode = 1;
    });
};
