// `nanoflow flow --json`: one snapshot of the local dev workflow (worktrees, their slot services, tickets,
// PRs, CI, the board), read-only. The JSON shape is the PROVIDER CONTRACT (version 1) the Claude Code mod
// reads, so it only ever grows additively.
import path from "node:path";
import type { FlowConfig, Status } from "./config.mjs";
import { issueUrl, repoSlug } from "./gh.mjs";
import { warn } from "./output.mjs";
import { tryRunAsync } from "./proc.mjs";
import type { RepoContext } from "./repo.mjs";
import { healthUrl, isUp, readStackState } from "./stack.mjs";
import { listWorktrees, portOf, ticketOf, type Worktree } from "./worktree.mjs";

export const FLOW_VERSION = 1;

export const CI_STATE = { pass: "pass", fail: "fail", pending: "pending", none: "none" } as const;
export type CiState = (typeof CI_STATE)[keyof typeof CI_STATE];

export interface FlowService {
  name: string;
  port: number;
  url: string;
  isUp: boolean;
}

export interface FlowTicket {
  number: number;
  title: string | null;
  url: string;
  state: string | null;
  /** Board column, e.g. "In progress". */
  status: string | null;
  /** Name of the worktree working on it. */
  worktree: string | null;
}

export interface FlowPr {
  number: number;
  url: string;
  /** OPEN | MERGED | CLOSED */
  state: string;
  ci: CiState;
  /** The first failing check's page when CI is red, else the first pending one. */
  ciUrl: string | null;
}

export interface FlowWorktree {
  name: string;
  path: string;
  branch: string | null;
  isMain: boolean;
  isCurrent: boolean;
  slot: number | null;
  dirty: number;
  ahead: number;
  services: FlowService[];
  /** The `nanoflow up --bg` stack recorded for this checkout. */
  stack: { apps: string[]; startedAt: string } | null;
  ticket: FlowTicket | null;
  pr: FlowPr | null;
}

export interface FlowSnapshot {
  version: typeof FLOW_VERSION;
  generatedAt: string;
  mainRoot: string;
  current: string | null;
  worktrees: FlowWorktree[];
  /** Tickets up next / in flight; null with --local. */
  board: FlowTicket[] | null;
}

/** The board columns a dashboard shows as "up next / in flight". */
const ACTIVE: Status[] = ["ready", "in-progress", "in-review"];

export interface CheckRun {
  status?: string;
  conclusion?: string | null;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);

/** Collapse a PR's statusCheckRollup into one state + the link worth opening. */
export const ciRollup = (checks: readonly CheckRun[]): { ci: CiState; ciUrl: string | null } => {
  if (checks.length === 0) return { ci: CI_STATE.none, ciUrl: null };
  const verdict = (c: CheckRun): string => (c.conclusion || c.state || c.status || "").toUpperCase();
  const link = (c: CheckRun | undefined): string | null => c?.detailsUrl ?? c?.targetUrl ?? null;
  const failed = checks.find((c) => FAILING.has(verdict(c)));
  if (failed) return { ci: CI_STATE.fail, ciUrl: link(failed) };
  const pending = checks.find((c) => PENDING.has(verdict(c)) || (c.status !== undefined && c.status !== "COMPLETED"));
  if (pending) return { ci: CI_STATE.pending, ciUrl: link(pending) };
  return { ci: CI_STATE.pass, ciUrl: null };
};

const norm = (p: string): string => {
  const n = path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
};
const isInside = (dir: string, root: string): boolean => {
  const rel = path.relative(norm(root), norm(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const servicesFor = (config: FlowConfig, slot: number): Promise<FlowService[]> =>
  Promise.all(
    config.services.flatMap((s) => {
      const port = portOf(s, slot);
      const health = healthUrl(config, s, slot);
      if (port === null || !health) return [];
      const url = new URL(health.href);
      url.pathname = "/";
      return [isUp(health, 1500).then((up) => ({ name: s.name, port, url: url.href, isUp: up }))];
    }),
  );

const countLines = (out: string | null): number => (out ? out.split(/\r?\n/).filter(Boolean).length : 0);


const localWorktree = async (repo: RepoContext, wt: Worktree): Promise<FlowWorktree> => {
  const { config } = repo;
  const isMain = norm(wt.path) === norm(repo.mainRoot);
  const slot = wt.meta?.slot ?? (isMain ? config.slot.mainSlot : null);
  const branch = wt.branch ?? null;
  const [status, ahead, services] = await Promise.all([
    tryRunAsync("git", ["status", "--porcelain", "--ignore-submodules=dirty"], { cwd: wt.path }),
    isMain || !branch ? Promise.resolve("0") : tryRunAsync("git", ["rev-list", "--count", `${config.mainBranch}..${branch}`], { cwd: wt.path }),
    slot === null ? Promise.resolve([]) : servicesFor(config, slot),
  ]);
  const stack = readStackState(config, wt.path);
  const n = isMain ? null : ticketOf(config, branch, wt.meta?.feature, path.basename(wt.path));
  const name = path.basename(wt.path);
  return {
    name,
    path: wt.path,
    branch,
    isMain,
    isCurrent: false,
    slot,
    dirty: countLines(status),
    ahead: Number(ahead ?? 0) || 0,
    services,
    stack: stack ? { apps: stack.apps, startedAt: stack.startedAt } : null,
    ticket: n === null ? null : { number: n, title: null, url: config.github.repo || config.ticket.urlTemplate ? issueUrl(repo, n) : "", state: null, status: null, worktree: name },
    pr: null,
  };
};

/** The checkout the cwd is in: the deepest worktree path containing it. */
const markCurrent = (trees: FlowWorktree[], cwd: string): string | null => {
  const current = trees.filter((t) => isInside(cwd, t.path)).sort((a, b) => b.path.length - a.path.length)[0]?.path ?? null;
  for (const t of trees) t.isCurrent = t.path === current;
  return current;
};

// ─── GitHub: ONE GraphQL query per full snapshot ─────────────────────────────
// Per-worktree `gh issue view` + `gh pr list` + a board listing cost ~20 GraphQL calls per refresh, and a
// dashboard polling that every 90s eats the 5,000/hr budget shared with every other gh user on the machine.
// One aliased query asks for the open issues (with their board column), each worktree's ticket, and each
// worktree's newest PR with its CI rollup.

const PROJECT_STATUS = `projectItems(first: 10) { nodes { project { number owner { ... on Organization { login } ... on User { login } } } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }`;
const ISSUE_FIELDS = `number title url state ${PROJECT_STATUS}`;
const PR_FIELDS = `number url state commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { status conclusion detailsUrl } ... on StatusContext { state targetUrl } } } } } } }`;

/** The query, with an alias per worktree ticket (t<i>) and per worktree branch (p<i>). */
export const buildFlowQuery = (trees: readonly FlowWorktree[]): string => {
  const parts = trees.flatMap((t, i) => [
    ...(t.ticket ? [`t${i}: issue(number: ${t.ticket.number}) { ${ISSUE_FIELDS} }`] : []),
    ...(t.branch && !t.isMain ? [`p${i}: pullRequests(headRefName: ${JSON.stringify(t.branch)}, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }`] : []),
  ]);
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
  open: issues(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${ISSUE_FIELDS} } }
  ${parts.join("\n  ")}
} }`;
};

interface GqlIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  projectItems?: { nodes: { project: { number: number; owner: { login?: string } }; fieldValueByName: { name?: string } | null }[] };
}
interface GqlPr {
  number: number;
  url: string;
  state: string;
  commits?: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: (CheckRun & { __typename: string })[] } } | null } }[] };
}
type GqlRepo = Record<string, unknown> & { open?: { nodes: GqlIssue[] } };

/** The issue's column on the configured board, or null. */
const statusIn = (repo: RepoContext, issue: GqlIssue): string | null => {
  const b = repo.config.github.board;
  if (!b) return null;
  const item = issue.projectItems?.nodes.find((n) => n.project.number === b.number && n.project.owner.login?.toLowerCase() === b.owner.toLowerCase());
  return item?.fieldValueByName?.name ?? null;
};

/** Fold the query's answer into the worktrees, and return the tickets up next / in flight. */
export const applyFlowResult = (repo: RepoContext, trees: FlowWorktree[], data: GqlRepo): FlowTicket[] => {
  trees.forEach((t, i) => {
    const issue = data[`t${i}`] as GqlIssue | null | undefined;
    if (t.ticket && issue) {
      Object.assign(t.ticket, { title: issue.title, state: issue.state, status: statusIn(repo, issue), url: repo.config.ticket.urlTemplate ? t.ticket.url : issue.url });
    }
    const pr = (data[`p${i}`] as { nodes: GqlPr[] } | null | undefined)?.nodes[0];
    if (pr) {
      const contexts = pr.commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
      t.pr = { number: pr.number, url: pr.url, state: pr.state, ...ciRollup(contexts) };
    } else if (!t.isMain) t.pr = null;
  });
  const worktreeOf = new Map(trees.flatMap((t) => (t.ticket ? [[t.ticket.number, t.name] as const] : [])));
  const b = repo.config.github.board;
  const active = b ? ACTIVE.map((s) => b.statuses[s]) : null;
  return (data.open?.nodes ?? [])
    .map((r) => ({ number: r.number, title: r.title, url: r.url, state: r.state, status: statusIn(repo, r), worktree: worktreeOf.get(r.number) ?? null }))
    .filter((r) => active === null || (r.status !== null && active.includes(r.status)));
};

const withGithub = async (repo: RepoContext, trees: FlowWorktree[]): Promise<FlowTicket[] | null> => {
  const [owner, name] = repoSlug(repo).split("/");
  const out = await tryRunAsync("gh", ["api", "graphql", "-f", `query=${buildFlowQuery(trees)}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "--jq", ".data.repository"]);
  if (!out) {
    warn("GitHub read failed (offline, not logged in, or rate-limited): showing local data only");
    return null;
  }
  try {
    return applyFlowResult(repo, trees, JSON.parse(out) as GqlRepo);
  } catch {
    return null;
  }
};

/** Build the snapshot. `local` skips every GitHub call (fast enough to poll every few seconds). */
export const collectFlow = async (repo: RepoContext, args: { cwd: string; local: boolean }): Promise<FlowSnapshot> => {
  const trees = await Promise.all(listWorktrees(repo.config, repo.mainRoot).map((wt) => localWorktree(repo, wt)));
  const current = markCurrent(trees, args.cwd);
  const board = args.local ? null : await withGithub(repo, trees);
  return { version: FLOW_VERSION, generatedAt: new Date().toISOString(), mainRoot: repo.mainRoot.replace(/\\/g, "/"), current, worktrees: trees, board };
};
