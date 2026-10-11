// Jira Cloud, for repos with ticket.tracker "jira": read a ticket, move it through the workflow, comment,
// create. Two ways in, picked per process:
//   1. acli, Atlassian's CLI, the way GitHub goes through gh: `acli jira auth login --web` once, and acli
//      keeps the login. nanoflow never sees a secret.
//   2. An Atlassian API token over the REST API, for CI or a machine without acli: JIRA_EMAIL +
//      JIRA_API_TOKEN, or `nf jira login` (saved in ~/.claude/nanoflow/credentials.json, never in the repo).
// JIRA_EMAIL + JIRA_API_TOKEN win (CI asks for exactly that); then acli; then the saved token.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { FlowConfig, Status } from "./config.mjs";
import { runAsync } from "./proc.mjs";

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

/** What nanoflow asks of Jira, whichever way it gets there. */
export interface JiraBackend {
  readonly site: string;
  /** "acli", or "token" (the REST API). */
  readonly via: "acli" | "token";
  /** The signed-in account, which also proves the login works. */
  myself(): Promise<string>;
  issue(key: string): Promise<JiraIssue>;
  /** Several tickets in one call (the dashboard); unknown keys are missing from the map. */
  issues(keys: readonly string[]): Promise<Map<string, JiraIssue>>;
  comment(key: string, text: string): Promise<void>;
  /**
   * Move the ticket to the status jira.statuses names for this step. A workflow without that transition is
   * reported, not thrown: workflows differ per project, and the task goes on.
   */
  moveTo(key: string, step: Status): Promise<{ moved: boolean; note: string }>;
  /** Create a ticket in jira.project; `body` is markdown-ish (`### Heading` sections). */
  create(args: { title: string; type: string; body: string }): Promise<JiraIssue>;
}

export class JiraError extends Error {}

// ─── credentials (the token fallback) ────────────────────────────────────────

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

const envCreds = (): JiraCreds | null => {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  return email && token ? { email, token } : null;
};

/** The token for a site: JIRA_EMAIL + JIRA_API_TOKEN, else what `nf jira login` saved. */
export const jiraCreds = (site: string): JiraCreds | null => envCreds() ?? readCredentials().jira?.[siteKey(site)] ?? null;

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

// ─── picking the way in ──────────────────────────────────────────────────────

export interface AcliStatus {
  /** acli runs at all. */
  installed: boolean;
  /** `acli jira auth status` succeeded. */
  loggedIn: boolean;
  /** The site acli is signed in to, when its status names one (`acme.atlassian.net`). */
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

const ACLI_HOW ="`acli jira auth login --web` (https://developer.atlassian.com/cloud/acli/guides/install-acli/)";

export type JiraPick = { client: JiraBackend; reason?: never } | { client: null; reason: string };

/** The way into this repo's Jira, or null with the reason (no site, not logged in anywhere). */
export const jiraClient = async (config: FlowConfig): Promise<JiraPick> => {
  if (config.ticket.tracker !== "jira") return { client: null, reason: "tickets are not in Jira" };
  if (!config.jira.site) return { client: null, reason: 'no jira.site in nanoflow.json (e.g. "https://acme.atlassian.net")' };
  const site = siteKey(config.jira.site);
  const fromEnv = envCreds();
  if (fromEnv) return { client: new RestJira(config, site, fromEnv) };
  const acli = await acliStatus();
  const acliHere = acli.loggedIn && (!acli.site || acli.site === site);
  if (acliHere) return { client: new AcliJira(config, site) };
  const saved = readCredentials().jira?.[site];
  if (saved) return { client: new RestJira(config, site, saved) };
  const why = !acli.installed
    ? `not logged in to ${site}: install acli, then ${ACLI_HOW}; or \`nf jira login\` with an API token`
    : !acli.loggedIn
      ? `acli is not logged in: ${ACLI_HOW}, or \`nf jira login\` with an API token`
      : `acli is logged in to ${acli.site}, not ${site}: \`acli jira auth switch\`, or \`nf jira login\` with an API token`;
  return { client: null, reason: why };
};

/** The Jira issue type for a --type: jira.issueTypes, else Bug for bug/fix and Task for the rest. */
export const jiraIssueType = (config: FlowConfig, type: string): string =>
  config.jira.issueTypes[type] ?? (["bug", "fix", "hotfix"].includes(type) ? "Bug" : "Task");

const VALID_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

// ─── 1. acli ─────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});

/**
 * One work item from acli's JSON, which is Jira's issue JSON ({ key, fields: { summary, status } }) or a
 * flattened row ({ key, summary, status }); both are read. A status without a category counts as closed when
 * it is the repo's "done" status.
 */
export const issueFromAcli = (config: FlowConfig, site: string, raw: unknown): JiraIssue | null => {
  const j = rec(raw);
  const fields = rec(j.fields);
  const key = typeof j.key === "string" ? j.key : null;
  if (!key) return null;
  const status = rec(fields.status ?? j.status);
  const statusName = typeof (fields.status ?? j.status) === "string" ? String(fields.status ?? j.status) : String(status.name ?? "");
  const category = rec(status.statusCategory).key;
  const done = category === "done" || (category === undefined && statusName.toLowerCase() === config.jira.statuses.done.toLowerCase());
  return {
    key,
    title: String(fields.summary ?? j.summary ?? ""),
    status: statusName,
    state: done ? "CLOSED" : "OPEN",
    url: `${site}/browse/${key}`,
  };
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export class AcliJira implements JiraBackend {
  readonly via = "acli" as const;

  constructor(
    private readonly config: FlowConfig,
    readonly site: string,
  ) {}

  private async acli(args: string[]): Promise<string> {
    const res = await runAsync("acli", ["jira", ...args]);
    if (res.code !== 0) throw new JiraError(`acli jira ${args.slice(0, 2).join(" ")}: ${res.stderr || res.stdout || `exit ${res.code}`}`);
    return res.stdout;
  }

  async myself(): Promise<string> {
    const { detail } = await acliStatus();
    return /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(detail)?.[0] ?? (detail.split(/\r?\n/).find(Boolean) || "acli");
  }

  async issue(key: string): Promise<JiraIssue> {
    const out = await this.acli(["workitem", "view", key, "--fields", "key,summary,status", "--json"]);
    const issue = issueFromAcli(this.config, this.site, parseJson(out));
    if (!issue) throw new JiraError(`acli jira workitem view ${key}: no work item in its output`);
    return issue;
  }

  async issues(keys: readonly string[]): Promise<Map<string, JiraIssue>> {
    const valid = [...new Set(keys)].filter((k) => VALID_KEY.test(k));
    if (!valid.length) return new Map();
    const out = await this.acli(["workitem", "search", "--jql", `key in (${valid.join(",")})`, "--fields", "key,summary,status", "--limit", "100", "--json"]);
    const raw = parseJson(out);
    const rows = Array.isArray(raw) ? raw : (rec(raw).issues as unknown[] | undefined) ?? (rec(raw).workItems as unknown[] | undefined) ?? [];
    return new Map(rows.flatMap((r) => {
      const issue = issueFromAcli(this.config, this.site, r);
      return issue ? [[issue.key, issue] as const] : [];
    }));
  }

  async comment(key: string, text: string): Promise<void> {
    await this.acli(["workitem", "comment", "create", "--key", key, "--body", text]);
  }

  async moveTo(key: string, step: Status): Promise<{ moved: boolean; note: string }> {
    const target = this.config.jira.statuses[step];
    const current = await this.issue(key);
    if (current.status.toLowerCase() === target.toLowerCase()) return { moved: false, note: `${key} is already ${current.status}` };
    // acli finds the transition that leads to --status itself.
    const res = await runAsync("acli", ["jira", "workitem", "transition", "--key", key, "--status", target, "--yes"]);
    if (res.code !== 0) {
      const why = (res.stderr || res.stdout).split(/\r?\n/).find(Boolean) ?? `exit ${res.code}`;
      return { moved: false, note: `${key}: not moved from ${current.status} to "${target}" (${why}); map it in jira.statuses` };
    }
    return { moved: true, note: `${key} → ${target}` };
  }

  async create(args: { title: string; type: string; body: string }): Promise<JiraIssue> {
    const project = this.config.jira.project;
    if (!project) throw new JiraError('Creating a Jira ticket needs jira.project in nanoflow.json (e.g. "ED").');
    // acli takes plain text (it builds the rich text itself): headings become plain lines.
    const description = args.body.replace(/^#{1,6} (.*)$/gm, "$1");
    const out = await this.acli([
      "workitem", "create", "--project", project, "--type", jiraIssueType(this.config, args.type), "--summary", args.title, "--description", description, "--json",
    ]);
    const key = (() => {
      const j = rec(parseJson(out));
      const k = j.key ?? rec(j.workItem).key ?? rec(j.issue).key;
      return typeof k === "string" ? k : /\b([A-Z][A-Z0-9_]*-\d+)\b/.exec(out)?.[1];
    })();
    if (!key) throw new JiraError(`acli jira workitem create: no key in its output: ${out.slice(0, 200)}`);
    return { key, title: args.title, status: "", state: "OPEN", url: `${this.site}/browse/${key}` };
  }
}

// ─── 2. an API token over REST ───────────────────────────────────────────────
// Plain-text bodies go through API v2; search through v3's /search/jql (the old /search is gone).

interface IssueJson {
  key: string;
  fields: { summary?: string; status?: { name?: string; statusCategory?: { key?: string } } };
}

export class RestJira implements JiraBackend {
  readonly via = "token" as const;

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

  private toIssue(j: IssueJson): JiraIssue {
    return {
      key: j.key,
      title: j.fields.summary ?? "",
      status: j.fields.status?.name ?? "",
      state: j.fields.status?.statusCategory?.key === "done" ? "CLOSED" : "OPEN",
      url: `${this.site}/browse/${j.key}`,
    };
  }

  async myself(): Promise<string> {
    const me = await this.request<{ displayName?: string; emailAddress?: string }>("GET", "/rest/api/2/myself");
    return me.displayName ?? me.emailAddress ?? this.creds.email;
  }

  async issue(key: string): Promise<JiraIssue> {
    return this.toIssue(await this.request<IssueJson>("GET", `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status`));
  }

  async issues(keys: readonly string[]): Promise<Map<string, JiraIssue>> {
    const valid = [...new Set(keys)].filter((k) => VALID_KEY.test(k));
    if (!valid.length) return new Map();
    const params = new URLSearchParams({ jql: `key in (${valid.join(",")})`, fields: "summary,status", maxResults: "100" });
    const res = await this.request<{ issues?: IssueJson[] }>("GET", `/rest/api/3/search/jql?${params}`);
    return new Map((res.issues ?? []).map((j) => [j.key, this.toIssue(j)]));
  }

  async comment(key: string, text: string): Promise<void> {
    await this.request("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body: text });
  }

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

  async create(args: { title: string; type: string; body: string }): Promise<JiraIssue> {
    const project = this.config.jira.project;
    if (!project) throw new JiraError('Creating a Jira ticket needs jira.project in nanoflow.json (e.g. "ED").');
    // API v2 descriptions are wiki markup: `h3.` headings.
    const description = args.body.replace(/^### /gm, "h3. ");
    const created = await this.request<{ key: string }>("POST", "/rest/api/2/issue", {
      fields: { project: { key: project }, summary: args.title, issuetype: { name: jiraIssueType(this.config, args.type) }, description },
    });
    return { key: created.key, title: args.title, status: "", state: "OPEN", url: `${this.site}/browse/${created.key}` };
  }
}
