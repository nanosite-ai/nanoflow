// The repo a command acts on: the checkout the cwd is in (main or a worktree), the main checkout, and the
// merged nanoflow.json.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type FlowConfig } from "./config.mjs";
import { tryRun } from "./proc.mjs";

export interface RepoContext {
  /** Top of the checkout the cwd is in (a worktree or the main checkout). */
  checkoutRoot: string;
  /** The main checkout (primary worktree). */
  mainRoot: string;
  /** The shared .git directory. */
  gitCommonDir: string;
  branch: string;
  config: FlowConfig;
  configFile: string | null;
}

export const findRepo = (cwd = process.cwd()): RepoContext | null => {
  const top = tryRun("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (!top) return null;
  const checkoutRoot = path.resolve(top);
  const common = tryRun("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: checkoutRoot });
  const gitCommonDir = common ? path.resolve(common) : path.join(checkoutRoot, ".git");
  const mainRoot = path.dirname(gitCommonDir);
  const { config, file } = loadConfig(checkoutRoot, mainRoot);
  return {
    checkoutRoot,
    mainRoot,
    gitCommonDir,
    branch: tryRun("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: checkoutRoot }) ?? "",
    config,
    configFile: file,
  };
};

export const requireRepo = (cwd = process.cwd()): RepoContext => {
  const repo = findRepo(cwd);
  if (!repo) throw new Error("Not inside a git repository. cd into your project (or one of its worktrees) and retry.");
  return repo;
};

export const isMainCheckout = (repo: RepoContext): boolean => path.resolve(repo.checkoutRoot) === path.resolve(repo.mainRoot);

/**
 * Keep nanoflow's local files out of git without touching the repo's .gitignore: .git/info/exclude is
 * shared by every worktree and never committed.
 */
export const ensureExcluded = (repo: RepoContext, patterns: string[]): void => {
  const file = path.join(repo.gitCommonDir, "info", "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = patterns.filter((p) => !have.has(p));
  if (!missing.length) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}# nanoflow\n${missing.join("\n")}\n`);
};
