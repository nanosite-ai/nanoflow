// Branch-vs-main questions several commands ask.
import { tryRun } from "./proc.mjs";

const lines = (out: string | null): string[] => (out ?? "").split(/\r?\n/).filter(Boolean);

/** Best-effort refresh of origin/<main> so "since main" is accurate (offline is fine). */
export const fetchMain = (cwd: string, main: string): void => {
  tryRun("git", ["fetch", "-q", "origin", main], { cwd });
};

/** Commit subjects on this branch since origin/<main>, oldest first. */
export const commitsSinceMain = (cwd: string, main: string): string[] =>
  lines(tryRun("git", ["log", "--reverse", "--format=%s", `origin/${main}..HEAD`], { cwd }));

/** Changed files in the working tree (git status --porcelain lines). */
export const dirtyCount = (cwd: string): number => lines(tryRun("git", ["status", "--porcelain"], { cwd })).length;

export const branchExists = (cwd: string, branch: string): boolean =>
  tryRun("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd }) !== null;
