import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { info } from "./output.mjs";

export interface GlobalOpts {
  json?: boolean;
  yes?: boolean;
  dry?: boolean;
}

/** Program-level flags, readable from any (sub)command action. */
export const globals = (cmd: Command): GlobalOpts => cmd.optsWithGlobals<GlobalOpts>();

/** The --dry guard: `if (dryRun(cmd, "would …")) return;` before the first side effect. */
export const dryRun = (cmd: Command, ...whatWouldHappen: string[]): boolean => {
  if (!globals(cmd).dry) return false;
  for (const line of whatWouldHappen) info(`[dry] ${line}`);
  return true;
};

/** "651" or "#651" → 651 (issue and PR numbers). */
export const parseIssueNumber = (raw: string | number): number => {
  const n = Number(String(raw).replace(/^#/, ""));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Not an issue/PR number: "${raw}"`);
  return n;
};

/** Write content to a fresh temp file and return its path (for gh --body-file / --input). */
export const tempFile = (name: string, content: string): string => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "nanoflow-")), name);
  writeFileSync(file, content);
  return file;
};

/** Attach the --slot / --wt target options to a command that acts on a local slot. */
export const withEnvOptions = (cmd: Command): Command =>
  cmd
    .option("--slot <n>", "local slot (default: the current worktree's slot)")
    .option("--wt <name>", "worktree whose slot to target");
