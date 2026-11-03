// `nanoflow usage --json`: the tokens each Claude Code session spent, per worktree, split by kind (input,
// output, cache read, cache write) and by model, read from the sessions' transcripts. A transcript sits
// under `~/.claude/projects/<the folder the session started in, slugged>/<session id>.jsonl`, its
// subagents' under `<session id>/subagents/`. A session that started in the main checkout counts for the
// worktree its title names (the custom-title record `nf task start` writes), else for the main checkout.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { IS_WIN } from "./proc.mjs";

export const USAGE_VERSION = 1;

export interface TokenCounts {
  /** Uncached input tokens. */
  input: number;
  output: number;
  /** Input tokens the prompt cache served. */
  cacheRead: number;
  /** Input tokens written to the prompt cache. */
  cacheWrite: number;
  /** API responses counted. */
  requests: number;
}

export interface SessionUsage {
  id: string;
  /** The session's last custom title (`/rename`, `nf task start`), or null. */
  title: string | null;
  startedAt: string | null;
  updatedAt: string;
  /** By model id (`claude-opus-5-5`), subagents included. */
  models: Record<string, TokenCounts>;
  total: TokenCounts;
}

export interface WorktreeUsage {
  name: string;
  path: string;
  branch: string | null;
  /** Newest first. */
  sessions: SessionUsage[];
  models: Record<string, TokenCounts>;
  total: TokenCounts;
}

export interface UsageSnapshot {
  version: typeof USAGE_VERSION;
  generatedAt: string;
  worktrees: WorktreeUsage[];
  models: Record<string, TokenCounts>;
  total: TokenCounts;
}

export const zeroCounts = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });

export const addCounts = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  requests: a.requests + b.requests,
});

/** Sum several by-model tables into one. */
export const mergeModels = (tables: Array<Record<string, TokenCounts>>): Record<string, TokenCounts> => {
  const out: Record<string, TokenCounts> = {};
  for (const table of tables) for (const [model, counts] of Object.entries(table)) out[model] = addCounts(out[model] ?? zeroCounts(), counts);
  return out;
};

export const totalOf = (models: Record<string, TokenCounts>): TokenCounts => Object.values(models).reduce(addCounts, zeroCounts());

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface TranscriptUsage {
  models: Record<string, TokenCounts>;
  title: string | null;
  startedAt: string | null;
}

/**
 * Tokens one transcript records. A response is written once per content block, each copy with the same
 * message id and usage, so each id counts once (its last copy). Responses that cost nothing (the engine's
 * own `<synthetic>` notes) are left out.
 */
export const parseTranscript = (text: string): TranscriptUsage => {
  const byId = new Map<string, { model: string; counts: TokenCounts }>();
  let title: string | null = null;
  let startedAt: string | null = null;
  let anon = 0;
  for (const line of text.split("\n")) {
    // Cheap filters first: most lines are neither a response nor a title.
    const hasUsage = line.includes('"usage"');
    const hasTitle = line.includes('"custom-title"');
    if (!startedAt && line.includes('"timestamp"')) startedAt = /"timestamp":"([^"]+)"/.exec(line)?.[1] ?? null;
    if (!hasUsage && !hasTitle) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type === "custom-title" && typeof rec.customTitle === "string") {
      title = rec.customTitle;
      continue;
    }
    if (rec.type !== "assistant") continue;
    const message = rec.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
    const usage = message?.usage;
    if (!usage || typeof message?.model !== "string") continue;
    const counts: TokenCounts = {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      requests: 1,
    };
    if (counts.input + counts.output + counts.cacheRead + counts.cacheWrite === 0) continue;
    const id = typeof message.id === "string" ? message.id : `anon-${anon++}`;
    byId.set(id, { model: message.model, counts });
  }
  const models: Record<string, TokenCounts> = {};
  for (const { model, counts } of byId.values()) models[model] = addCounts(models[model] ?? zeroCounts(), counts);
  return { models, title, startedAt };
};

/** The folder name Claude Code keeps a checkout's sessions under: every non-alphanumeric becomes `-`. */
export const projectSlug = (dir: string): string => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, "-");

/** The branch as a whole word in a title: feat/83-x must not find feat/830-y. */
export const titleNamesBranch = (title: string | null, branch: string | null): boolean => {
  if (!title || !branch) return false;
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w/-])${escaped}(?![\\w-])`).test(title);
};

export const claudeProjectsDir = (): string => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "projects");

/** The project folder for a checkout, matched without case on Windows; null when it has no sessions. */
const projectDirFor = (projects: string, dir: string, names: readonly string[]): string | null => {
  const slug = projectSlug(dir);
  const hit = names.find((n) => (IS_WIN ? n.toLowerCase() === slug.toLowerCase() : n === slug));
  return hit ? path.join(projects, hit) : null;
};

interface Transcript {
  id: string;
  file: string;
  mtimeMs: number;
}

const transcriptsIn = (dir: string | null, sinceMs: number): Transcript[] => {
  if (!dir) return [];
  const out: Transcript[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    const { mtimeMs } = statSync(file);
    if (mtimeMs >= sinceMs) out.push({ id: name.slice(0, -".jsonl".length), file, mtimeMs });
  }
  return out;
};

/** One session: its transcript and its subagents' summed. */
export const readSession = (t: Transcript): SessionUsage => {
  const main = parseTranscript(readFileSync(t.file, "utf8"));
  const subDir = path.join(path.dirname(t.file), t.id, "subagents");
  const subs = existsSync(subDir)
    ? readdirSync(subDir).filter((n) => n.endsWith(".jsonl")).map((n) => parseTranscript(readFileSync(path.join(subDir, n), "utf8")).models)
    : [];
  const models = mergeModels([main.models, ...subs]);
  return { id: t.id, title: main.title, startedAt: main.startedAt, updatedAt: new Date(t.mtimeMs).toISOString(), models, total: totalOf(models) };
};

export interface UsageTree {
  name: string;
  path: string;
  branch: string | null;
  isMain: boolean;
}

/**
 * Every worktree's sessions. A worktree counts its own folder's sessions and the main checkout's sessions
 * titled with its branch, both from when it was made; the main checkout keeps the rest of its own, from
 * `days` ago.
 */
export const collectUsage = (trees: readonly UsageTree[], opts: { days: number; now?: number; projects?: string }): UsageSnapshot => {
  const now = opts.now ?? Date.now();
  const projects = opts.projects ?? claudeProjectsDir();
  const names = existsSync(projects) ? readdirSync(projects) : [];
  const main = trees.find((t) => t.isMain);
  const mainSince = now - opts.days * 86_400_000;
  const created = (t: UsageTree): number => {
    if (!existsSync(t.path)) return now;
    const st = statSync(t.path);
    return st.birthtimeMs || st.ctimeMs;
  };
  const others = trees.filter((t) => !t.isMain);
  const oldest = Math.min(mainSince, ...others.map(created));
  const mainDir = main ? projectDirFor(projects, main.path, names) : null;
  const mainSessions = transcriptsIn(mainDir, oldest).map((t) => ({ t, s: readSession(t) }));
  const claimed = new Set<string>();
  const result: WorktreeUsage[] = trees.map((tree) => {
    let sessions: SessionUsage[];
    if (tree.isMain) sessions = [];
    else {
      const since = created(tree);
      const own = transcriptsIn(projectDirFor(projects, tree.path, names), since).map(readSession);
      const fromMain = mainSessions.filter(({ t, s }) => t.mtimeMs >= since && titleNamesBranch(s.title, tree.branch)).map(({ s }) => s);
      for (const s of fromMain) claimed.add(s.id);
      sessions = [...own, ...fromMain];
    }
    return { name: tree.name, path: tree.path, branch: tree.branch, sessions, models: {}, total: zeroCounts() };
  });
  const mainUsage = main ? result[trees.indexOf(main)] : undefined;
  if (mainUsage) mainUsage.sessions = mainSessions.filter(({ t, s }) => t.mtimeMs >= mainSince && !claimed.has(s.id)).map(({ s }) => s);
  for (const r of result) {
    r.sessions = r.sessions.filter((s) => s.total.requests > 0).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    r.models = mergeModels(r.sessions.map((s) => s.models));
    r.total = totalOf(r.models);
  }
  const models = mergeModels(result.map((r) => r.models));
  return { version: USAGE_VERSION, generatedAt: new Date(now).toISOString(), worktrees: result, models, total: totalOf(models) };
};

/** 950, 12.3k, 4.56M: short enough for a dashboard row. */
export const formatTokens = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
};

/** `claude-opus-5-5` → `opus-5-5`. */
export const shortModel = (model: string): string => model.replace(/^claude-/, "");
