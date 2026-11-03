// `nanoflow usage --json`: the tokens each Claude Code session spent, per worktree, split by kind (input,
// output, cache read, cache write) and by model, read from the sessions' transcripts. A transcript sits
// under `~/.claude/projects/<the folder the session started in, slugged>/<session id>.jsonl`, its
// subagents' under `<session id>/subagents/`. A session that started in the main checkout counts for the
// worktree its title names (the custom-title record `nf task start` writes), else for the main checkout.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
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

/** One response: its message id (null when it has none: never matched to another), model and four counts. */
export type Reply = [id: string | null, model: string, input: number, output: number, cacheRead: number, cacheWrite: number];

export interface ParsedTranscript {
  /** Each response once, in the order first written. */
  replies: Reply[];
  /** The session's last custom title, or null. */
  title: string | null;
  startedAt: string | null;
}

/**
 * The responses one transcript records. A response is written once per content block, each copy with the
 * same message id and usage, so each id is kept once (its last copy). Responses that cost nothing (the
 * engine's own `<synthetic>` notes) are left out.
 */
export const parseLines = (lines: Iterable<string>): ParsedTranscript => {
  const byId = new Map<string, Reply>();
  let title: string | null = null;
  let startedAt: string | null = null;
  let anon = 0;
  for (const line of lines) {
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
    const reply: Reply = [
      typeof message.id === "string" ? message.id : null,
      message.model,
      num(usage.input_tokens),
      num(usage.output_tokens),
      num(usage.cache_read_input_tokens),
      num(usage.cache_creation_input_tokens),
    ];
    if (reply[2] + reply[3] + reply[4] + reply[5] === 0) continue;
    byId.set(reply[0] ?? `\0${anon++}`, reply);
  }
  return { replies: [...byId.values()], title, startedAt };
};

export const parseTranscript = (text: string): ParsedTranscript => parseLines(text.split("\n"));

/** A file's lines, read a chunk at a time: a transcript can be larger than one string may be. */
export function* linesOf(file: string, chunkBytes = 1 << 20): Generator<string> {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(chunkBytes);
    const decoder = new StringDecoder("utf8");
    let rest = "";
    for (let n = readSync(fd, buf, 0, chunkBytes, null); n > 0; n = readSync(fd, buf, 0, chunkBytes, null)) {
      const lines = (rest + decoder.write(buf.subarray(0, n))).split("\n");
      rest = lines.pop() ?? "";
      yield* lines;
    }
    rest += decoder.end();
    if (rest) yield rest;
  } finally {
    closeSync(fd);
  }
}

/**
 * Responses as counts by model, each message id once across everything `seen` has met: a resumed or
 * continued session's transcript repeats the responses it carries over, which count for the first session.
 */
export const modelsOf = (replies: readonly Reply[], seen: Set<string>): Record<string, TokenCounts> => {
  const models: Record<string, TokenCounts> = {};
  for (const [id, model, input, output, cacheRead, cacheWrite] of replies) {
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    models[model] = addCounts(models[model] ?? zeroCounts(), { input, output, cacheRead, cacheWrite, requests: 1 });
  }
  return models;
};

/** The folder name Claude Code keeps a checkout's sessions under: every non-alphanumeric becomes `-`. */
export const projectSlug = (dir: string): string => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, "-");

/** The branch as a whole word in a title: feat/83-x must not find feat/830-y. */
export const titleNamesBranch = (title: string | null, branch: string | null): boolean => {
  if (!title || !branch) return false;
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w/-])${escaped}(?![\\w-])`).test(title);
};

/** Claude Code's config folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");

/** Where Claude Code keeps every session's transcript, one folder per checkout it started in. */
export const claudeProjectsDir = (): string => path.join(claudeConfigDir(), "projects");

/** The project folder for a checkout, matched without case on Windows; null when it has no sessions. */
const projectDirFor = (projects: string, dir: string, names: readonly string[]): string | null => {
  const slug = projectSlug(dir);
  const hit = names.find((n) => (IS_WIN ? n.toLowerCase() === slug.toLowerCase() : n === slug));
  return hit ? path.join(projects, hit) : null;
};

const CACHE_VERSION = 1;
const CREATED_SLACK_MS = 1000;
type CacheEntry = { mtimeMs: number; size: number; parsed: ParsedTranscript };
type Cache = { version: typeof CACHE_VERSION; files: Record<string, CacheEntry> };

/**
 * Parsed transcripts, kept between runs by file, mtime and size: the pane asks after every turn, and only
 * the transcripts written since are read again. A cache that cannot be read starts empty.
 */
class TranscriptCache {
  private readonly old: Record<string, CacheEntry>;
  private readonly next: Record<string, CacheEntry> = {};

  constructor(private readonly file: string | null) {
    let old: Record<string, CacheEntry> = {};
    try {
      const data = file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Cache) : null;
      if (data?.version === CACHE_VERSION && data.files) old = data.files;
    } catch {
      old = {};
    }
    this.old = old;
  }

  /** A transcript's responses, or null when it cannot be read (gone mid-scan, unreadable). */
  read(file: string): ParsedTranscript | null {
    try {
      const { mtimeMs, size } = statSync(file);
      const hit = this.old[file];
      const entry = hit && hit.mtimeMs === mtimeMs && hit.size === size ? hit : { mtimeMs, size, parsed: parseLines(linesOf(file)) };
      this.next[file] = entry;
      return entry.parsed;
    } catch {
      return null;
    }
  }

  /** Keeps only the transcripts this run met. */
  save(): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ version: CACHE_VERSION, files: this.next } satisfies Cache));
    } catch {
      // A cache is only a shortcut.
    }
  }
}

export const defaultCacheFile = (): string => path.join(claudeConfigDir(), "nanoflow", "usage-cache.json");

interface Transcript {
  id: string;
  file: string;
  mtimeMs: number;
}

const transcriptsIn = (dir: string | null, sinceMs: number): Transcript[] => {
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Transcript[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    try {
      const { mtimeMs } = statSync(file);
      if (mtimeMs >= sinceMs) out.push({ id: name.slice(0, -".jsonl".length), file, mtimeMs });
    } catch {
      // Gone since the listing.
    }
  }
  return out;
};

interface ReadSession {
  t: Transcript;
  main: ParsedTranscript;
  subs: ParsedTranscript[];
}

/** A session's own transcript and its subagents', parsed; null when its transcript cannot be read. */
const readSession = (t: Transcript, cache: TranscriptCache): ReadSession | null => {
  const main = cache.read(t.file);
  if (!main) return null;
  const subDir = path.join(path.dirname(t.file), t.id, "subagents");
  let subs: ParsedTranscript[] = [];
  try {
    if (existsSync(subDir)) subs = readdirSync(subDir).filter((n) => n.endsWith(".jsonl")).flatMap((n) => cache.read(path.join(subDir, n)) ?? []);
  } catch {
    subs = [];
  }
  return { t, main, subs };
};

export interface UsageTree {
  name: string;
  path: string;
  branch: string | null;
  isMain: boolean;
}

/**
 * Every worktree's sessions. A worktree counts its own folder's sessions and the main checkout's sessions
 * titled with its branch since it was made; the main checkout keeps the rest of its own from `days` ago.
 * A response repeated in several transcripts (a resumed session) counts once, for the earliest session.
 */
export const collectUsage = (
  trees: readonly UsageTree[],
  opts: { days: number; now?: number; projects?: string; cacheFile?: string | null },
): UsageSnapshot => {
  const now = opts.now ?? Date.now();
  const projects = opts.projects ?? claudeProjectsDir();
  const cache = new TranscriptCache(opts.cacheFile === undefined ? defaultCacheFile() : opts.cacheFile);
  const names = existsSync(projects) ? readdirSync(projects) : [];
  const mainSince = now - opts.days * 86_400_000;
  // Birth time only: a folder's ctime moves whenever an entry in it changes. Without one, every session counts.
  // A second early: birth times can be finer than mtimes (APFS: below a millisecond), so a session written in
  // the same moment the worktree was made would otherwise read as older than it.
  const created = (t: UsageTree): number => {
    try {
      const born = statSync(t.path).birthtimeMs;
      return born ? born - CREATED_SLACK_MS : 0;
    } catch {
      return now;
    }
  };
  const main = trees.find((t) => t.isMain);
  const since = new Map(trees.map((t) => [t, t.isMain ? mainSince : created(t)]));
  const read = (list: Transcript[]): ReadSession[] => list.flatMap((t) => readSession(t, cache) ?? []);
  const mainDir = main ? projectDirFor(projects, main.path, names) : null;
  const fromMain = read(transcriptsIn(mainDir, Math.min(mainSince, ...since.values())));
  const own = new Map(trees.filter((t) => !t.isMain).map((t) => [t, read(transcriptsIn(projectDirFor(projects, t.path, names), 0))]));
  cache.save();

  // Each response counts once, for the oldest session that has it.
  const all = [...fromMain, ...[...own.values()].flat()].sort(
    (a, b) => (a.main.startedAt ?? "").localeCompare(b.main.startedAt ?? "") || a.t.mtimeMs - b.t.mtimeMs,
  );
  const seen = new Set<string>();
  const usageOf = new Map<ReadSession, SessionUsage>();
  for (const r of all) {
    const models = mergeModels([modelsOf(r.main.replies, seen), ...r.subs.map((s) => modelsOf(s.replies, seen))]);
    usageOf.set(r, { id: r.t.id, title: r.main.title, startedAt: r.main.startedAt, updatedAt: new Date(r.t.mtimeMs).toISOString(), models, total: totalOf(models) });
  }
  const sessions = (list: ReadSession[]): SessionUsage[] => list.flatMap((r) => usageOf.get(r) ?? []);

  const claimed = new Set<ReadSession>();
  const sessionsFor = new Map<UsageTree, SessionUsage[]>();
  for (const tree of trees) {
    if (tree.isMain) continue;
    const from = since.get(tree) ?? 0;
    const titled = fromMain.filter((r) => r.t.mtimeMs >= from && titleNamesBranch(r.main.title, tree.branch));
    for (const r of titled) claimed.add(r);
    sessionsFor.set(tree, sessions([...(own.get(tree) ?? []), ...titled]));
  }
  if (main) sessionsFor.set(main, sessions(fromMain.filter((r) => r.t.mtimeMs >= mainSince && !claimed.has(r))));

  const worktrees: WorktreeUsage[] = trees.map((tree) => {
    const list = (sessionsFor.get(tree) ?? []).filter((s) => s.total.requests > 0).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const models = mergeModels(list.map((s) => s.models));
    return { name: tree.name, path: tree.path, branch: tree.branch, sessions: list, models, total: totalOf(models) };
  });
  const models = mergeModels(worktrees.map((w) => w.models));
  return { version: USAGE_VERSION, generatedAt: new Date(now).toISOString(), worktrees, models, total: totalOf(models) };
};

/** 950, 12.3k, 4.56M: short enough for a dashboard row; rounded first, then placed (999,800 is 1.00M, not 1000k). */
export const formatTokens = (n: number): string => {
  if (n < 1000) return String(n);
  const k = n / 1000;
  if (Number(k.toFixed(k < 10 ? 1 : 0)) < 1000) return Number(k.toFixed(1)) < 10 ? `${k.toFixed(1)}k` : `${k.toFixed(0)}k`;
  const m = n / 1_000_000;
  return Number(m.toFixed(2)) < 10 ? `${m.toFixed(2)}M` : `${m.toFixed(1)}M`;
};

/** `claude-opus-5-5` → `opus-5-5`. */
export const shortModel = (model: string): string => model.replace(/^claude-/, "");
