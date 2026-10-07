// Thin gh wrappers. Filtering always uses gh's built-in --jq, so no jq binary is needed. The board's
// GraphQL ids are looked up once and cached in .git/nanoflow/board.json, never pasted into config.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type BoardConfig, type Status } from "./config.mjs";
import { tempFile } from "./globals.mjs";
import { run, tryRun } from "./proc.mjs";
import type { RepoContext } from "./repo.mjs";

export const gh = (args: string[], cwd?: string): string => run("gh", args, { cwd });

/** owner/name from a GitHub remote URL (https or ssh), else null. */
export const slugFromRemote = (url: string): string | null =>
  /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.slice(1, 3).join("/") ?? null;

/** owner/name of the GitHub repo: from config, else the origin remote, else asked of gh. */
export const repoSlug = (repo: RepoContext): string => {
  if (repo.config.github.repo) return repo.config.github.repo;
  const remote = tryRun("git", ["remote", "get-url", "origin"], { cwd: repo.mainRoot });
  const slug = (remote && slugFromRemote(remote)) ?? tryRun("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: repo.mainRoot });
  if (!slug) throw new Error('Could not tell the GitHub repo (is `gh auth login` done?). Set "github": { "repo": "owner/name" } in .claude/nanoflow.json.');
  repo.config.github.repo = slug;
  return slug;
};

/** `gh <issue|pr|run …> --repo <slug>`, so it works from any cwd (not for `gh api`). */
export const ghRepo = (repo: RepoContext, args: string[], cwd?: string): string => gh([...args, "--repo", repoSlug(repo)], cwd);

export const issueUrl = (repo: RepoContext, n: number): string =>
  repo.config.ticket.urlTemplate
    ? repo.config.ticket.urlTemplate.replace("{ticket}", String(n))
    : new URL(`/${repoSlug(repo)}/issues/${n}`, "https://github.com").href;

// ─── Issues ──────────────────────────────────────────────────────────────────

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  url: string;
}

export const viewIssue = (repo: RepoContext, n: number): IssueSummary =>
  JSON.parse(ghRepo(repo, ["issue", "view", String(n), "--json", "number,title,state,url"])) as IssueSummary;

export const createIssue = (repo: RepoContext, args: { title: string; body: string; labels: string[] }): number => {
  const url = ghRepo(repo, [
    "issue", "create", "--title", args.title, "--body-file", tempFile("issue.md", args.body),
    ...args.labels.flatMap((l) => ["--label", l]),
  ]);
  const match = /\/issues\/(\d+)/.exec(url);
  if (!match) throw new Error(`Unexpected gh issue create output: ${url}`);
  return Number(match[1]);
};

/** Link #child under #parent (GitHub sub-issues). */
export const linkSubIssue = (repo: RepoContext, parent: number, child: number): void => {
  const slug = repoSlug(repo);
  const id = gh(["api", `repos/${slug}/issues/${child}`, "--jq", ".id"]);
  gh(["api", "-X", "POST", `repos/${slug}/issues/${parent}/sub_issues`, "-F", `sub_issue_id=${id}`]);
};

export const commentIssue = (repo: RepoContext, n: number, body: string): void => {
  ghRepo(repo, ["issue", "comment", String(n), "--body", body]);
};

// ─── Pull requests ───────────────────────────────────────────────────────────

export const PR_STATE = { open: "open", merged: "merged", all: "all" } as const;
export type PrState = (typeof PR_STATE)[keyof typeof PR_STATE];

export interface PrRef {
  number: number;
  url: string;
  /** OPEN | MERGED | CLOSED */
  state: string;
}

export const prForBranch = (repo: RepoContext, branch: string, state: PrState): PrRef | null => {
  const raw = ghRepo(repo, ["pr", "list", "--head", branch, "--state", state, "--json", "number,url,state", "--jq", ".[0]"]);
  return raw ? (JSON.parse(raw) as PrRef) : null;
};

export const prField = (repo: RepoContext, pr: number, field: string): string =>
  ghRepo(repo, ["pr", "view", String(pr), "--json", field, "--jq", `.${field}`]);

export const setPrBody = (repo: RepoContext, pr: number, body: string): void => {
  ghRepo(repo, ["pr", "edit", String(pr), "--body-file", tempFile("pr.md", body)]);
};

// ─── Project board (GitHub Projects v2) ──────────────────────────────────────

interface BoardIds {
  key: string;
  projectId: string;
  statusFieldId: string;
  /** Option name → id. */
  options: Record<string, string>;
}

const boardKey = (b: BoardConfig): string => `${b.owner}/${b.number}`;
const cacheFile = (repo: RepoContext): string => path.join(repo.gitCommonDir, "nanoflow", "board.json");

const fetchBoardIds = (b: BoardConfig): BoardIds => {
  const n = String(b.number);
  const projectId = gh(["project", "view", n, "--owner", b.owner, "--format", "json", "--jq", ".id"]);
  const fields = JSON.parse(gh(["project", "field-list", n, "--owner", b.owner, "--format", "json"])) as {
    fields: { id: string; name: string; options?: { id: string; name: string }[] }[];
  };
  const status = fields.fields.find((f) => f.name.toLowerCase() === "status" && f.options);
  if (!status) throw new Error(`Project ${boardKey(b)} has no "Status" single-select field.`);
  return { key: boardKey(b), projectId, statusFieldId: status.id, options: Object.fromEntries((status.options ?? []).map((o) => [o.name, o.id])) };
};

const boardIds = (repo: RepoContext, b: BoardConfig, refresh = false): BoardIds => {
  const file = cacheFile(repo);
  if (!refresh && existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as BoardIds;
      if (cached.key === boardKey(b)) return cached;
    } catch {
      // fall through and refetch
    }
  }
  const ids = fetchBoardIds(b);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(ids, null, 2));
  return ids;
};

const optionId = (ids: BoardIds, name: string): string | undefined =>
  ids.options[name] ?? Object.entries(ids.options).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

/** Board item id for issue #n, adding the issue to the board first if needed. */
const ensureBoardItem = (repo: RepoContext, b: BoardConfig, n: number): string => {
  const found = gh([
    "project", "item-list", String(b.number), "--owner", b.owner, "--format", "json", "--limit", "1000",
    "--jq", `.items[] | select(.content.number==${n}) | .id`,
  ]).split(/\r?\n/)[0];
  return found || gh(["project", "item-add", String(b.number), "--owner", b.owner, "--url", issueUrl(repo, n), "--format", "json", "--jq", ".id"]);
};

/** Set an issue's Status column. Returns false (and changes nothing) when no board is configured. */
export const setBoardStatus = (repo: RepoContext, n: number, status: Status): boolean => {
  const b = repo.config.github.board;
  if (!b) return false;
  const name = b.statuses[status];
  let ids = boardIds(repo, b);
  let option = optionId(ids, name);
  if (!option) {
    ids = boardIds(repo, b, true);
    option = optionId(ids, name);
  }
  if (!option) throw new Error(`Board ${boardKey(b)} has no Status "${name}". Columns: ${Object.keys(ids.options).join(", ")}. Map it in github.board.statuses.`);
  gh(["project", "item-edit", "--id", ensureBoardItem(repo, b, n), "--project-id", ids.projectId, "--field-id", ids.statusFieldId, "--single-select-option-id", option]);
  return true;
};

export interface BoardItem {
  number: number;
  title: string;
  status: string;
  url: string;
}

/** Board issues in the given columns (by display name). */
export const boardItems = (repo: RepoContext, columns: string[]): BoardItem[] => {
  const b = repo.config.github.board;
  if (!b) return [];
  const names = JSON.stringify(columns);
  const raw = gh([
    "project", "item-list", String(b.number), "--owner", b.owner, "--format", "json", "--limit", "1000",
    "--jq", `[.items[] | select(.content.type=="Issue" and (.status as $s | ${names} | index($s))) | {number: .content.number, title: .content.title, status: .status, url: .content.url}]`,
  ]);
  return JSON.parse(raw || "[]") as BoardItem[];
};

export const ghAuthOk = (): boolean => tryRun("gh", ["auth", "status"]) !== null;
