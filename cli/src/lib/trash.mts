// The worktree trash: removal renames a worktree in here (instant) and deletes it in the background, so
// `wt remove` doesn't block on deleting node_modules (~45s for 123k files on Windows).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { IS_WIN } from "./proc.mjs";

/** A killed dev server can hold files for a moment after it exits, which makes the rename fail. */
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 300;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** `<parent>/.<repo>-trash`: next to the worktrees, so moving one in is a same-volume rename, never a copy. */
export const trashRootFor = (mainRoot: string, worktreeDir: string): string =>
  path.join(path.dirname(path.resolve(worktreeDir)), `.${path.basename(path.resolve(mainRoot))}-trash`);

/**
 * Move `dir` into `root` with one rename and return its new path. Throws the last rename error when a file
 * inside stays open (Windows refuses to rename a dir with open handles).
 */
export const moveToTrash = (root: string, dir: string, now = Date.now()): string => {
  mkdirSync(root, { recursive: true });
  const target = path.join(root, `${path.basename(dir)}-${now}`);
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(dir, target);
      return target;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS) throw err;
      sleepSync(RENAME_RETRY_MS);
    }
  }
};

/**
 * Delete every entry of the trash in detached processes and return at once. Entries left by an earlier
 * delete that hit a locked file are picked up again here. `rmdir /s /q` on Windows deletes a node_modules
 * tree ~1.6x faster than fs.rmSync (28s vs 45s for 123k files).
 */
export const emptyTrashInBackground = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root).map((name) => path.join(root, name));
  for (const entry of entries) {
    const [cmd, args] = IS_WIN ? ["cmd.exe", ["/d", "/c", "rmdir", "/s", "/q", entry]] : ["rm", ["-rf", entry]];
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
  return entries;
};
