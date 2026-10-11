// Jira Cloud, for repos with ticket.tracker "jira": read a ticket, move it through the workflow, comment,
// create. nanoflow goes through acli, Atlassian's CLI, the way it goes through gh for GitHub: you log in once
// (`acli jira auth login --web`), acli keeps the login, and nanoflow never holds a secret.
import type { FlowConfig, Status } from "./config.mjs";
import { runAsync } from "./proc.mjs";

export interface JiraIssue {
  key: string;
  title: string;
  /** The workflow status, e.g. "In Progress". */
  status: string;
  /** OPEN, or CLOSED once the status is in Jira's "done" category: the same states GitHub issues have. */
  state: "OPEN" | "CLOSED";
  url: string;
}

export class JiraError extends Error {}

/** "https://acme.atlassian.net/" → "https://acme.atlassian.net". */
export const siteKey = (site: string): string => new URL(site).origin;

export interface AcliStatus {
  /** acli runs at all. */
  installed: boolean;
  /** `acli jira auth status` succeeded. */
  loggedIn: boolean;
  /** The site acli is signed in to (its status prints `Site: acme.atlassian.net`). */
  site: string | null;
  /** Its status output, for messages. */
  detail: string;
}

let acliStatusCache: Promise<AcliStatus> | null = null;

/** Is acli there, and signed in to which site? Asked once per process. */
export const acliStatus = (): Promise<AcliStatus> =>
  (acliStatusCache ??= runAsync("acli", ["jira", "auth", "status"]).then(({ code, stdout, stderr }) => {
    const out = `${stdout}\n${stderr}`.trim();
    const installed = code !== 127 && !/not recognized|not found|ENOENT/i.test(out);
    const host = /([\w-]+\.(?:atlassian\.net|jira\.com|jira-dev\.com))/i.exec(out)?.[1] ?? null;
    return { installed, loggedIn: installed && code === 0, site: host ? `https://${host.toLowerCase()}` : null, detail: out };
  }));

/** Forget the cached status (after a login). */
export const resetAcliStatus = (): void => {
  acliStatusCache = null;
};

export const ACLI_INSTALL = "https://developer.atlassian.com/cloud/acli/guides/install-acli/";

export type JiraPick = { client: Jira; reason?: never } | { client: null; reason: string };

/** acli for this repo's Jira, or null with the reason (no site, not installed, not logged in, another site). */
export const jiraClient = async (config: FlowConfig): Promise<JiraPick> => {
  if (config.ticket.tracker !== "jira") return { client: null, reason: "tickets are not in Jira" };
  if (!config.jira.site) return { client: null, reason: 'no jira.site in nanoflow.json (e.g. "https://acme.atlassian.net")' };
  const site = siteKey(config.jira.site);
  const acli = await acliStatus();
  if (!acli.installed) return { client: null, reason: `acli is not installed (${ACLI_INSTALL}), then \`nf jira login\`` };
  if (!acli.loggedIn) return { client: null, reason: "acli is not logged in: `nf jira login` in your terminal" };
  if (acli.site && acli.site !== site) return { client: null, reason: `acli is logged in to ${acli.site}, not ${site}: \`acli jira auth switch\`` };
  return { client: new Jira(config, site) };
};

/** The Jira issue type for a --type: jira.issueTypes, else Bug for bug/fix and Task for the rest. */
export const jiraIssueType = (config: FlowConfig, type: string): string =>
  config.jira.issueTypes[type] ?? (["bug", "fix", "hotfix"].includes(type) ? "Bug" : "Task");

const VALID_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});

/** One work item from acli's --json: Jira's issue JSON, { key, fields: { summary, status: { name, statusCategory } } }. */
export const issueFromAcli = (site: string, raw: unknown): JiraIssue | null => {
  const j = rec(raw);
  if (typeof j.key !== "string") return null;
  const fields = rec(j.fields);
  const status = rec(fields.status);
  return {
    key: j.key,
    title: String(fields.summary ?? ""),
    status: String(status.name ?? ""),
    state: rec(status.statusCategory).key === "done" ? "CLOSED" : "OPEN",
    url: `${site}/browse/${j.key}`,
  };
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export class Jira {
  constructor(
    private readonly config: FlowConfig,
    readonly site: string,
  ) {}

  private async acli(args: string[]): Promise<string> {
    const res = await runAsync("acli", ["jira", ...args]);
    if (res.code !== 0) throw new JiraError(`acli jira ${args.slice(0, 2).join(" ")}: ${res.stderr || res.stdout || `exit ${res.code}`}`);
    return res.stdout;
  }

  /** The signed-in account (acli's status prints `Email: …`). */
  async myself(): Promise<string> {
    const { detail } = await acliStatus();
    return /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(detail)?.[0] ?? (detail.split(/\r?\n/).find(Boolean) || "acli");
  }

  async issue(key: string): Promise<JiraIssue> {
    const out = await this.acli(["workitem", "view", key, "--fields", "key,summary,status", "--json"]);
    const issue = issueFromAcli(this.site, parseJson(out));
    if (!issue) throw new JiraError(`acli jira workitem view ${key}: no work item in its output`);
    return issue;
  }

  /** Several tickets in one search (the dashboard); unknown keys are left out. */
  async issues(keys: readonly string[]): Promise<Map<string, JiraIssue>> {
    const valid = [...new Set(keys)].filter((k) => VALID_KEY.test(k));
    if (!valid.length) return new Map();
    const out = await this.acli(["workitem", "search", "--jql", `key in (${valid.join(",")})`, "--fields", "key,summary,status", "--limit", "100", "--json"]);
    const rows = parseJson(out);
    return new Map((Array.isArray(rows) ? rows : []).flatMap((r) => {
      const issue = issueFromAcli(this.site, r);
      return issue ? [[issue.key, issue] as const] : [];
    }));
  }

  /** A plain-text comment (acli builds Jira's rich text). */
  async comment(key: string, text: string): Promise<void> {
    await this.acli(["workitem", "comment", "create", "--key", key, "--body", text]);
  }

  /**
   * Move the ticket to the status jira.statuses names for this step; acli finds the transition that leads
   * there. A workflow without one is reported, not thrown: workflows differ per project, and the task goes on.
   */
  async moveTo(key: string, step: Status): Promise<{ moved: boolean; note: string }> {
    const target = this.config.jira.statuses[step];
    const current = await this.issue(key);
    if (current.status.toLowerCase() === target.toLowerCase()) return { moved: false, note: `${key} is already ${current.status}` };
    const res = await runAsync("acli", ["jira", "workitem", "transition", "--key", key, "--status", target, "--yes"]);
    if (res.code !== 0) {
      const why = (res.stderr || res.stdout).split(/\r?\n/).find(Boolean) ?? `exit ${res.code}`;
      return { moved: false, note: `${key}: not moved from ${current.status} to "${target}" (${why}); map it in jira.statuses` };
    }
    return { moved: true, note: `${key} → ${target}` };
  }

  /** Create a ticket in jira.project; `body` is markdown-ish, and its `###` headings become plain lines. */
  async create(args: { title: string; type: string; body: string }): Promise<JiraIssue> {
    const project = this.config.jira.project;
    if (!project) throw new JiraError('Creating a Jira ticket needs jira.project in nanoflow.json (e.g. "ED").');
    const description = args.body.replace(/^#{1,6} (.*)$/gm, "$1");
    const out = await this.acli([
      "workitem", "create", "--project", project, "--type", jiraIssueType(this.config, args.type), "--summary", args.title, "--description", description, "--json",
    ]);
    const k = rec(parseJson(out)).key;
    const key = typeof k === "string" ? k : /\b([A-Z][A-Z0-9_]*-\d+)\b/.exec(out)?.[1];
    if (!key) throw new JiraError(`acli jira workitem create: no key in its output: ${out.slice(0, 200)}`);
    return { key, title: args.title, status: "", state: "OPEN", url: `${this.site}/browse/${key}` };
  }
}
