// Jira Cloud over its REST API, for repos with ticket.tracker "jira": read a ticket, move it through the
// workflow, comment, create. Auth is an Atlassian API token (Basic email:token), from JIRA_EMAIL +
// JIRA_API_TOKEN or saved by `nf jira login` in ~/.claude/nanoflow/credentials.json, never in the repo.
// Plain-text bodies go through API v2; search through v3's /search/jql (the old /search is gone).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { FlowConfig, Status } from "./config.mjs";

export interface JiraCreds {
  email: string;
  token: string;
}

export interface JiraIssue {
  key: string;
  title: string;
  /** The workflow status, e.g. "In Progress". */
  status: string;
  /** OPEN, or CLOSED once the status is in Jira's "done" category: the same states GitHub issues have. */
  state: "OPEN" | "CLOSED";
  url: string;
}

export const credentialsFile = (): string =>
  path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "nanoflow", "credentials.json");

type CredentialsJson = { jira?: Record<string, JiraCreds> };

const readCredentials = (): CredentialsJson => {
  const file = credentialsFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CredentialsJson;
  } catch {
    return {};
  }
};

/** "https://acme.atlassian.net/" → "https://acme.atlassian.net": the key credentials are saved under. */
export const siteKey = (site: string): string => new URL(site).origin;

/** JIRA_EMAIL + JIRA_API_TOKEN first (CI, one-off), else what `nf jira login` saved for this site. */
export const jiraCreds = (site: string): JiraCreds | null => {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (email && token) return { email, token };
  return readCredentials().jira?.[siteKey(site)] ?? null;
};

export const saveJiraCreds = (site: string, creds: JiraCreds | null): string => {
  const file = credentialsFile();
  const all = readCredentials();
  const jira = { ...all.jira };
  if (creds) jira[siteKey(site)] = creds;
  else delete jira[siteKey(site)];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...all, jira }, null, 2)}\n`, { mode: 0o600 });
  return file;
};

export class JiraError extends Error {}

/** The client for a repo whose tickets are in Jira, or null with the reason (no site, not logged in). */
export const jiraClient = (config: FlowConfig): { client: Jira; reason?: never } | { client: null; reason: string } => {
  if (config.ticket.tracker !== "jira") return { client: null, reason: "tickets are not in Jira" };
  const site = config.jira.site;
  if (!site) return { client: null, reason: 'no jira.site in nanoflow.json (e.g. "https://acme.atlassian.net")' };
  const creds = jiraCreds(site);
  if (!creds) return { client: null, reason: `not logged in to ${siteKey(site)}: \`nf jira login\` (or set JIRA_EMAIL + JIRA_API_TOKEN)` };
  return { client: new Jira(config, siteKey(site), creds) };
};

interface IssueJson {
  key: string;
  fields: { summary?: string; status?: { name?: string; statusCategory?: { key?: string } } };
}

export class Jira {
  constructor(
    private readonly config: FlowConfig,
    readonly site: string,
    private readonly creds: JiraCreds,
  ) {}

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const url = new URL(route, this.site);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.creds.email}:${this.creds.token}`).toString("base64")}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new JiraError(`Jira unreachable (${this.site}): ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      const why = (() => {
        try {
          const j = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
          return [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join("; ");
        } catch {
          return text.slice(0, 200);
        }
      })();
      const hint = res.status === 401 ? " (log in again: `nf jira login`)" : "";
      throw new JiraError(`Jira ${method} ${url.pathname} → ${res.status}${why ? `: ${why}` : ""}${hint}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  url(key: string): string {
    return `${this.site}/browse/${key}`;
  }

  private toIssue(j: IssueJson): JiraIssue {
    return {
      key: j.key,
      title: j.fields.summary ?? "",
      status: j.fields.status?.name ?? "",
      state: j.fields.status?.statusCategory?.key === "done" ? "CLOSED" : "OPEN",
      url: this.url(j.key),
    };
  }

  /** The signed-in account: proves the token works. */
  async myself(): Promise<string> {
    const me = await this.request<{ displayName?: string; emailAddress?: string }>("GET", "/rest/api/2/myself");
    return me.displayName ?? me.emailAddress ?? this.creds.email;
  }

  async issue(key: string): Promise<JiraIssue> {
    return this.toIssue(await this.request<IssueJson>("GET", `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status`));
  }

  /** Several tickets in one call (the dashboard); unknown keys are simply missing from the map. */
  async issues(keys: readonly string[]): Promise<Map<string, JiraIssue>> {
    const valid = [...new Set(keys)].filter((k) => /^[A-Z][A-Z0-9_]*-\d+$/.test(k));
    if (!valid.length) return new Map();
    const params = new URLSearchParams({ jql: `key in (${valid.join(",")})`, fields: "summary,status", maxResults: "100" });
    const res = await this.request<{ issues?: IssueJson[] }>("GET", `/rest/api/3/search/jql?${params}`);
    return new Map((res.issues ?? []).map((j) => [j.key, this.toIssue(j)]));
  }

  async comment(key: string, text: string): Promise<void> {
    await this.request("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body: text });
  }

  /**
   * Move the ticket to the status jira.statuses names for this step, through whichever transition leads
   * there. Returns what happened in words; a workflow without such a transition is reported, not thrown:
   * workflows differ per project and the task itself still goes on.
   */
  async moveTo(key: string, step: Status): Promise<{ moved: boolean; note: string }> {
    const target = this.config.jira.statuses[step];
    const current = await this.issue(key);
    if (current.status.toLowerCase() === target.toLowerCase()) return { moved: false, note: `${key} is already ${current.status}` };
    const { transitions = [] } = await this.request<{ transitions?: { id: string; name: string; to?: { name?: string } }[] }>(
      "GET",
      `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
    );
    const same = (a: string | undefined): boolean => a?.toLowerCase() === target.toLowerCase();
    const t = transitions.find((x) => same(x.to?.name)) ?? transitions.find((x) => same(x.name));
    if (!t) {
      const options = [...new Set(transitions.map((x) => x.to?.name).filter(Boolean))].join(", ") || "none";
      return { moved: false, note: `${key}: no transition from ${current.status} to "${target}" (available: ${options}); map it in jira.statuses` };
    }
    await this.request("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    return { moved: true, note: `${key} → ${t.to?.name ?? target}` };
  }

  /** Create a ticket in jira.project; the issue type comes from jira.issueTypes by --type. */
  async create(args: { title: string; type: string; body: string }): Promise<JiraIssue> {
    const project = this.config.jira.project;
    if (!project) throw new JiraError('Creating a Jira ticket needs jira.project in nanoflow.json (e.g. "ED").');
    const issueType = jiraIssueType(this.config, args.type);
    const created = await this.request<{ key: string }>("POST", "/rest/api/2/issue", {
      fields: { project: { key: project }, summary: args.title, issuetype: { name: issueType }, description: args.body },
    });
    return { key: created.key, title: args.title, status: "", state: "OPEN", url: this.url(created.key) };
  }
}

/** The Jira issue type for a --type: jira.issueTypes, else Bug for bug/fix and Task for the rest. */
export const jiraIssueType = (config: FlowConfig, type: string): string =>
  config.jira.issueTypes[type] ?? (["bug", "fix", "hotfix"].includes(type) ? "Bug" : "Task");
