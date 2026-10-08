// Worktrees: slot → ports, template variables, the slot file, and the create/remove primitives. The one
// place the slot math lives: port = base + slot * step.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fillTemplate, type FlowConfig, type ServiceSpec, type TemplateVars } from "./config.mjs";
import { branchExists } from "./git.mjs";
import { killTree, processesInDir } from "./kill.mjs";
import { c, info, step, success, warn } from "./output.mjs";
import { run, runInherit, tryRun } from "./proc.mjs";
import { ensureExcluded, type RepoContext } from "./repo.mjs";

export interface WorktreeMeta {
  feature: string;
  slot: number;
  branch: string;
  createdAt?: string;
}

export interface Worktree {
  path: string;
  branch?: string;
  head?: string;
  meta: WorktreeMeta | null;
}

export const portOf = (s: ServiceSpec, slot: number): number | null =>
  typeof s.base === "number" ? s.base + slot * (s.step ?? 0) : null;

const originOf = (host: string, port: number): string => {
  const url = new URL("http://localhost");
  url.hostname = host;
  url.port = String(port);
  return url.origin;
};

/** Every placeholder a template may use for this slot: {slot} {feature} {repo} {host} {port:<svc>} {origin:<svc>}… */
export const slotVars = (config: FlowConfig, slot: number, extra: TemplateVars = {}): Record<string, string | number | null> => {
  const vars: Record<string, string | number | null> = { slot, host: config.host };
  for (const s of config.services) {
    const port = portOf(s, slot);
    if (port === null) continue;
    vars[`port:${s.name}`] = port;
    vars[`origin:${s.name}`] = originOf(config.host, port);
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) vars[k] = v;
  return vars;
};

/** The env a slot's processes get: env.export always, env.worktree only off the main slot. */
export const envForSlot = (config: FlowConfig, slot: number, vars: TemplateVars): Record<string, string> => {
  const fill = (m: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fillTemplate(v, vars)]));
  return { ...fill(config.env.export), ...(slot !== config.slot.mainSlot ? fill(config.env.worktree) : {}) };
};

/** Insert or replace `KEY=value` lines in .env text. */
export const upsertEnvText = (text: string, kv: Record<string, string>): string => {
  const lines = text ? text.replace(/(\r?\n)+$/, "").split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(kv)) {
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
};

export const readMeta = (config: FlowConfig, dir: string): WorktreeMeta | null => {
  const file = path.join(dir, config.slot.file);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const slot = Number(raw[config.slot.key]);
    if (!Number.isInteger(slot)) return null;
    return { feature: String(raw.feature ?? path.basename(dir)), slot, branch: String(raw.branch ?? ""), createdAt: raw.createdAt as string | undefined };
  } catch {
    return null;
  }
};

/** Parsed `git worktree list --porcelain`, with each tree's slot record. */
export const listWorktrees = (config: FlowConfig, cwd: string): Worktree[] => {
  const out = run("git", ["worktree", "list", "--porcelain"], { cwd });
  const trees: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = { path: path.resolve(line.slice(9).trim()), meta: null };
      trees.push(cur);
    } else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace("refs/heads/", "").trim();
    else if (line.startsWith("HEAD ") && cur) cur.head = line.slice(5).trim();
  }
  for (const wt of trees) wt.meta = readMeta(config, wt.path);
  return trees;
};

/** The slot of a checkout: its slot file, else the main slot. */
export const slotOf = (config: FlowConfig, dir: string): number => readMeta(config, dir)?.slot ?? config.slot.mainSlot;

/** Lowest unused slot above the main one. */
export const nextFreeSlot = (config: FlowConfig, trees: Worktree[]): number => {
  const used = new Set([config.slot.mainSlot, ...trees.flatMap((t) => (t.meta ? [t.meta.slot] : []))]);
  let n = config.slot.mainSlot + 1;
  while (used.has(n)) n += 1;
  return n;
};

/** "Lease expires mid-post" → "lease-expires-mid-post". */
/** Words that only pad a branch or tab title. */
const FILLER = new Set(["a", "an", "the", "for", "of", "to", "in", "on", "at", "with", "and", "or", "is", "be", "when", "after", "from", "by"]);

/** "Dark mode for the storefront" → "dark-mode-storefront": lowercase, no filler words, at most maxWords. */
export const slugify = (title: string, maxWords = 4): string => {
  const words = title.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  const meaningful = words.filter((w) => !FILLER.has(w));
  return (meaningful.length ? meaningful : words).slice(0, maxWords).join("-");
};

export const assertFeature = (feature: string | undefined): string => {
  if (!feature || !/^[a-z0-9][a-z0-9-]*$/.test(feature)) throw new Error(`Invalid name "${feature ?? ""}". Use lowercase letters, digits and hyphens.`);
  return feature;
};

/** The ticket number in a branch (or name), per ticket.branchPattern. */
export const ticketOf = (config: FlowConfig, ...candidates: (string | undefined | null)[]): number | null => {
  const re = new RegExp(config.ticket.branchPattern);
  for (const c of candidates) {
    const n = Number(re.exec(c ?? "")?.[1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
};

/** "<feature>" → { ticket, slug } when it starts with a number. */
const splitFeature = (feature: string): { ticket: string; slug: string } => {
  const m = /^(\d+)-(.+)$/.exec(feature);
  return m ? { ticket: m[1], slug: m[2] } : { ticket: "", slug: feature };
};

export const nameVars = (repo: RepoContext, feature: string): Record<string, string> => ({
  repo: path.basename(repo.mainRoot),
  feature,
  ...splitFeature(feature),
});

export const worktreeDirFor = (repo: RepoContext, feature: string): string =>
  path.resolve(repo.mainRoot, fillTemplate(repo.config.worktree.dir, nameVars(repo, feature)));

export const branchFor = (repo: RepoContext, feature: string): string => fillTemplate(repo.config.worktree.branch, nameVars(repo, feature));

/** A worktree by its feature, folder name, or folder name without the main checkout's prefix. */
export const findWorktree = (repo: RepoContext, trees: Worktree[], name: string): Worktree | undefined => {
  const prefix = `${path.basename(repo.mainRoot)}-`;
  return trees.find((t) => t.meta?.feature === name || path.basename(t.path) === name || path.basename(t.path) === `${prefix}${name}`);
};

export const servicesLine = (config: FlowConfig, slot: number): string => {
  const parts = config.services.flatMap((s) => {
    const port = portOf(s, slot);
    return port === null ? [] : [`${s.name} :${port}`];
  });
  return `slot ${slot}${parts.length ? `: ${parts.join(" | ")}` : ""}`;
};

/** Add the worktree + branch, copy and patch the shared files, record the slot, install. */
export const createWorktree = (repo: RepoContext, feature: string, opts: { slot?: number; install?: boolean } = {}): string => {
  const { config, mainRoot } = repo;
  assertFeature(feature);
  const slot = opts.slot ?? nextFreeSlot(config, listWorktrees(config, mainRoot));
  if (!Number.isInteger(slot) || slot === config.slot.mainSlot) throw new Error(`Invalid slot "${slot}": slot ${config.slot.mainSlot} is the main checkout.`);
  const dir = worktreeDirFor(repo, feature);
  const branch = branchFor(repo, feature);
  if (existsSync(dir)) throw new Error(`Target directory already exists: ${dir}`);

  step(`Creating worktree "${feature}" (${servicesLine(config, slot)})`);
  const reuse = branchExists(mainRoot, branch);
  run("git", ["worktree", "add", dir, ...(reuse ? [branch] : ["-b", branch])], { cwd: mainRoot });

  for (const rel of config.worktree.copy) {
    const src = path.join(mainRoot, rel);
    if (!existsSync(src)) continue;
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    copyFileSync(src, path.join(dir, rel));
  }
  const vars = slotVars(config, slot, nameVars(repo, feature));
  for (const [rel, kv] of Object.entries(config.env.files)) {
    const file = path.join(dir, rel);
    const filled = Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, fillTemplate(v, vars)]));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, upsertEnvText(existsSync(file) ? readFileSync(file, "utf8") : "", filled));
  }
  writeFileSync(
    path.join(dir, config.slot.file),
    `${JSON.stringify({ feature, [config.slot.key]: slot, branch, createdAt: new Date().toISOString() }, null, 2)}\n`,
  );
  ensureExcluded(repo, [`/${config.slot.file}`, `/${config.stack.stateDir}/`]);

  if (config.worktree.install && opts.install !== false) {
    step(`${config.worktree.install} (each worktree has its own dependencies)…`);
    if (runInherit(config.worktree.install, [], { cwd: dir, shell: true }) !== 0) {
      warn(`"${config.worktree.install}" did not complete cleanly: finish it in the worktree before \`nanoflow up\`.`);
    }
  }
  success(`worktree ready: ${dir}  (${servicesLine(config, slot)})`);
  return dir;
};

/** Refuse to delete work that exists nowhere else: uncommitted changes, or commits on no remote. */
const assertSafeToRemove = (dir: string, branch: string, allowUnpushed: boolean): void => {
  const dirty = tryRun("git", ["status", "--porcelain"], { cwd: dir }) ?? "";
  if (dirty) throw new Error(`Worktree has uncommitted changes:\n${dirty}\nCommit + push them, or pass --force to discard.`);
  if (allowUnpushed || !branchExists(dir, branch)) return;
  const unpushed = tryRun("git", ["log", "--oneline", branch, "--not", "--remotes"], { cwd: dir }) ?? "";
  if (unpushed) throw new Error(`Branch ${branch} has commits on no remote:\n${unpushed}\nPush them, or pass --force to discard.`);
};

/**
 * Stop its processes, delete the dir, prune, optionally delete the branch. Not `git worktree remove`: it
 * refuses worktrees with submodules and leaves half-deleted node_modules behind on Windows.
 */
export const removeWorktree = (repo: RepoContext, wt: { dir: string; branch: string }, opts: { force?: boolean; deleteBranch?: boolean; allowUnpushed?: boolean }): void => {
  if (!opts.force && existsSync(wt.dir)) assertSafeToRemove(wt.dir, wt.branch, Boolean(opts.allowUnpushed));
  const killed = killTree(processesInDir(wt.dir));
  if (killed.length) info(c.dim(`stopped ${killed.length} process(es) holding ${wt.dir}`));
  try {
    rmSync(wt.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  } catch (err) {
    throw new Error(`Could not delete ${wt.dir} (${(err as { code?: string }).code}): close editors/terminals opened in it, then retry.`);
  }
  run("git", ["worktree", "prune"], { cwd: repo.mainRoot });
  if (opts.deleteBranch && branchExists(repo.mainRoot, wt.branch)) run("git", ["branch", "-D", wt.branch], { cwd: repo.mainRoot });
  success(`removed ${path.basename(wt.dir)}${opts.deleteBranch ? ` + branch ${wt.branch}` : ""}`);
};

/** The teardown steps the CLI can't do itself (the agent's browser, its local files). */
export const printTeardownChecklist = (config: FlowConfig): void => {
  if (!config.teardown.checklist.length) return;
  info(c.bold("Agent cleanup (nanoflow can't do these):"));
  for (const item of config.teardown.checklist) info(`  • ${item}`);
};
