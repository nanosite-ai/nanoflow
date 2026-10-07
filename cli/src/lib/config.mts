// The repo's `.claude/nanoflow.json`: one file for the CLI and the Claude Code mod. Each reads the fields
// it knows and ignores the rest. Everything is optional; the defaults suit a plain git + GitHub repo.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const CONFIG_REL = path.join(".claude", "nanoflow.json");
export const SCHEMA_URL = "https://raw.githubusercontent.com/nanosite-ai/nanoflow/main/nanoflow.schema.json";

export const STATUS = {
  backlog: "backlog",
  ready: "ready",
  inProgress: "in-progress",
  inReview: "in-review",
  done: "done",
} as const;
export type Status = (typeof STATUS)[keyof typeof STATUS];
export const STATUSES = Object.values(STATUS);

export interface ServiceSpec {
  name: string;
  /** Port in the main checkout (slot 0); a service without one is a process only (e.g. a worker). */
  base?: number;
  /** Added per slot: port = base + slot * step. */
  step?: number;
  /** Health path; any HTTP answer means up. */
  path?: string;
  /** The service "open app" links go to. */
  open?: boolean;
  /** How `nanoflow up` starts it: a shell command, run in `cwd` (relative to the checkout). */
  start?: { run: string; cwd?: string };
  /** Started only when named: `nanoflow up --with <name>`. */
  optional?: boolean;
  /** `nanoflow up` waits for it to answer (default: true when it has a port). */
  ready?: boolean;
}

export interface BoardConfig {
  /** Owner of the GitHub Project (user or org login). */
  owner: string;
  /** The project number, from its URL: github.com/orgs/<owner>/projects/<number>. */
  number: number;
  /** Status column names on the board, per lifecycle step. */
  statuses: Record<Status, string>;
}

export interface FlowConfig {
  mainBranch: string;
  ticket: {
    /** First capture group = the ticket number, read from the branch. */
    branchPattern: string;
    urlTemplate?: string;
    /** Issue types `--type` accepts; each becomes a label through `labels.type`. */
    types: string[];
    /** Label templates: {type} and {area}. Empty string = no label. */
    labels: { type: string; area: string };
    /** Body sections for a new ticket and a new bug, in order. */
    sections: { ticket: string[]; bug: string[] };
  };
  github: { repo?: string; board: BoardConfig | null };
  slot: { file: string; key: string; mainSlot: number };
  host: string;
  services: ServiceSpec[];
  worktree: {
    /** Where new worktrees go, relative to the main checkout. Placeholders: {repo} {feature} {ticket} {slug}. */
    dir: string;
    /** The branch for a new worktree. */
    branch: string;
    /** Gitignored files copied from the main checkout (e.g. .env files), so secrets are shared. */
    copy: string[];
    /** Run in a new worktree after it is created; null to skip. */
    install: string | null;
  };
  env: {
    /** Exported to every process `nanoflow up` starts, in any checkout. */
    export: Record<string, string>;
    /** Exported only in worktrees (slot > main), e.g. a queue prefix that must differ from main's. */
    worktree: Record<string, string>;
    /** Written into the copied files of a new worktree: { "apps/server/.env": { "PORT": "{port:server}" } }. */
    files: Record<string, Record<string, string>>;
  };
  stack: {
    /** Per-checkout runtime state (logs, pid). Kept out of git through .git/info/exclude. */
    stateDir: string;
    /** Shell commands run before `nanoflow up` starts the services (e.g. build shared packages). */
    before: string[];
    timeoutSeconds: number;
  };
  /** `nanoflow check`: name → shell command. Output is condensed to the failures. */
  checks: Record<string, string>;
  pr: {
    /** Refuse a PR title that is not a Conventional Commit. */
    conventional: boolean;
    /** Screenshots go to this orphan branch, one folder per PR, out of the merge diff. */
    shotsBranch: string;
  };
  title: {
    /** Rename the Claude Code session and the terminal tab at each lifecycle step. */
    enabled: boolean;
    format: string;
  };
  teardown: { checklist: string[] };
}

export const DEFAULT_CONFIG: FlowConfig = {
  mainBranch: "main",
  ticket: {
    branchPattern: "(?:^|/)(\\d+)-",
    types: ["feature", "bug", "chore", "refactor"],
    labels: { type: "", area: "" },
    sections: {
      ticket: ["Definition", "Implementation plan", "Test plan", "Definition of Done"],
      bug: ["Symptom", "Reproduction", "Root cause", "Fix", "Testing"],
    },
  },
  github: { board: null },
  slot: { file: ".worktree.json", key: "slot", mainSlot: 0 },
  host: "localhost",
  services: [],
  worktree: { dir: "../{repo}-{feature}", branch: "feat/{feature}", copy: [".env"], install: null },
  env: { export: {}, worktree: {}, files: {} },
  stack: { stateDir: ".nanoflow", before: [], timeoutSeconds: 180 },
  checks: {},
  pr: { conventional: true, shotsBranch: "assets/pr-screenshots" },
  title: { enabled: true, format: "#{ticket} · {branch} · {short}" },
  teardown: {
    checklist: [
      "close any browser you opened for verification (Playwright MCP: browser_close)",
      "delete the screenshots/recordings you saved locally (e.g. .playwright-mcp/); the PR copies live on the screenshots branch",
    ],
  },
};

export const DEFAULT_STATUSES: Record<Status, string> = {
  backlog: "Backlog",
  ready: "Ready",
  "in-progress": "In progress",
  "in-review": "In review",
  done: "Done",
};

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const isStringMap = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every((s) => typeof s === "string");
const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const sub = (v: unknown): Json => (isRecord(v) ? v : {});

const validRegex = (source: string): boolean => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

const boardOf = (raw: unknown): BoardConfig | null => {
  if (!isRecord(raw) || typeof raw.owner !== "string" || typeof raw.number !== "number") return null;
  const statuses = isStringMap(raw.statuses) ? raw.statuses : {};
  return { owner: raw.owner, number: raw.number, statuses: { ...DEFAULT_STATUSES, ...statuses } as Record<Status, string> };
};

const servicesOf = (raw: unknown): ServiceSpec[] =>
  Array.isArray(raw)
    ? raw.filter((s): s is ServiceSpec => isRecord(s) && typeof s.name === "string").map((s) => ({
        ...s,
        start: isRecord(s.start) && typeof s.start.run === "string" ? { run: s.start.run, cwd: str(s.start.cwd, ".") } : undefined,
      }))
    : [];

/** Merge a parsed nanoflow.json over the defaults. Ill-typed fields fall back to the default. */
export const mergeConfig = (raw: unknown): FlowConfig => {
  const r = sub(raw);
  const d = DEFAULT_CONFIG;
  const ticket = sub(r.ticket);
  const labels = sub(ticket.labels);
  const sections = sub(ticket.sections);
  const github = sub(r.github);
  const slot = sub(r.slot);
  const wt = sub(r.worktree);
  const env = sub(r.env);
  const stack = sub(r.stack);
  const pr = sub(r.pr);
  const title = sub(r.title);
  const teardown = sub(r.teardown);
  const pattern = str(ticket.branchPattern, d.ticket.branchPattern);
  return {
    mainBranch: str(r.mainBranch, d.mainBranch),
    ticket: {
      branchPattern: validRegex(pattern) ? pattern : d.ticket.branchPattern,
      ...(typeof ticket.urlTemplate === "string" ? { urlTemplate: ticket.urlTemplate } : {}),
      types: isStrings(ticket.types) && ticket.types.length ? ticket.types : d.ticket.types,
      labels: { type: str(labels.type, d.ticket.labels.type), area: str(labels.area, d.ticket.labels.area) },
      sections: {
        ticket: isStrings(sections.ticket) ? sections.ticket : d.ticket.sections.ticket,
        bug: isStrings(sections.bug) ? sections.bug : d.ticket.sections.bug,
      },
    },
    github: { ...(typeof github.repo === "string" ? { repo: github.repo } : {}), board: boardOf(github.board) },
    slot: { file: str(slot.file, d.slot.file), key: str(slot.key, d.slot.key), mainSlot: num(slot.mainSlot, d.slot.mainSlot) },
    host: str(r.host, d.host),
    services: Array.isArray(r.services) ? servicesOf(r.services) : d.services,
    worktree: {
      dir: str(wt.dir, d.worktree.dir),
      branch: str(wt.branch, d.worktree.branch),
      copy: isStrings(wt.copy) ? wt.copy : d.worktree.copy,
      install: wt.install === null ? null : str(wt.install, d.worktree.install ?? "") || null,
    },
    env: {
      export: isStringMap(env.export) ? env.export : {},
      worktree: isStringMap(env.worktree) ? env.worktree : {},
      files: isRecord(env.files)
        ? Object.fromEntries(Object.entries(env.files).filter((e): e is [string, Record<string, string>] => isStringMap(e[1])))
        : {},
    },
    stack: {
      stateDir: str(stack.stateDir, d.stack.stateDir),
      before: isStrings(stack.before) ? stack.before : [],
      timeoutSeconds: num(stack.timeoutSeconds, d.stack.timeoutSeconds),
    },
    checks: isStringMap(r.checks) ? r.checks : {},
    pr: { conventional: bool(pr.conventional, d.pr.conventional), shotsBranch: str(pr.shotsBranch, d.pr.shotsBranch) },
    title: { enabled: bool(title.enabled, d.title.enabled), format: str(title.format, d.title.format) },
    teardown: { checklist: isStrings(teardown.checklist) ? teardown.checklist : d.teardown.checklist },
  };
};

/** Where the config is read from, first hit wins: this checkout, the main checkout, then the user's copy. */
export const configCandidates = (checkoutRoot: string, mainRoot: string): string[] => [
  path.join(checkoutRoot, CONFIG_REL),
  path.join(mainRoot, CONFIG_REL),
  path.join(homedir(), ".claude", "nanoflow", `${path.basename(mainRoot)}.json`),
];

export const loadConfig = (checkoutRoot: string, mainRoot: string): { config: FlowConfig; file: string | null } => {
  for (const file of configCandidates(checkoutRoot, mainRoot)) {
    if (!existsSync(file)) continue;
    try {
      return { config: mergeConfig(JSON.parse(readFileSync(file, "utf8"))), file };
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
    }
  }
  return { config: DEFAULT_CONFIG, file: null };
};

export type TemplateVars = Readonly<Record<string, string | number | null | undefined>>;

/**
 * Fill {name} and {name:arg} placeholders. `{port:server}` reads vars["port:server"]. Unknown ones throw,
 * so a typo in nanoflow.json fails loudly instead of writing an empty value.
 */
export const fillTemplate = (text: string, vars: TemplateVars): string =>
  text.replace(/\{(\w+(?::[\w-]+)?)\}/g, (_m, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Unknown placeholder {${key}} in "${text}". Known: ${Object.keys(vars).map((k) => `{${k}}`).join(" ")}`);
    return value === null ? "" : String(value);
  });
