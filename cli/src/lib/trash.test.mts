import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { emptyTrashInBackground, moveToTrash, trashRootFor } from "./trash.mjs";

const roots: string[] = [];

/** A main checkout and one worktree next to it, holding a tiny node_modules. */
const makeTree = (): { parent: string; main: string; dir: string } => {
  const parent = mkdtempSync(path.join(tmpdir(), "nanoflow-trash-"));
  roots.push(parent);
  const main = path.join(parent, "demo");
  const dir = path.join(parent, "demo-1-csv");
  mkdirSync(main);
  for (const pkg of ["a", "b"]) {
    mkdirSync(path.join(dir, "node_modules", pkg), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", pkg, "index.js"), "module.exports = 1;\n");
  }
  return { parent, main, dir };
};

const waitUntil = async (check: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

describe("worktree trash", () => {
  test("sits next to the worktrees and is named after the repo", () => {
    const { parent, main, dir } = makeTree();
    expect(trashRootFor(main, dir)).toBe(path.join(parent, ".demo-trash"));
  });

  test("moves the worktree into the trash in one rename", () => {
    const { main, dir } = makeTree();
    const target = moveToTrash(trashRootFor(main, dir), dir, 123);
    expect(existsSync(dir)).toBe(false);
    expect(path.basename(target)).toBe("demo-1-csv-123");
    expect(existsSync(path.join(target, "node_modules", "b", "index.js"))).toBe(true);
  });

  test("throws when the dir is gone, so the caller can fall back", () => {
    const { parent, main } = makeTree();
    const missing = path.join(parent, "demo-2-missing");
    expect(() => moveToTrash(trashRootFor(main, missing), missing)).toThrow();
  });

  test("deletes every entry in the background, leftovers from earlier runs included", async () => {
    const { parent, main, dir } = makeTree();
    const root = trashRootFor(main, dir);
    moveToTrash(root, dir, 1);
    const older = path.join(parent, "demo-3-older");
    mkdirSync(path.join(older, "node_modules", "x"), { recursive: true });
    moveToTrash(root, older, 2);

    expect(emptyTrashInBackground(root)).toHaveLength(2);
    expect(await waitUntil(() => readdirSync(root).length === 0)).toBe(true);
  });

  test("does nothing when there is no trash yet", () => {
    const { main, dir } = makeTree();
    expect(emptyTrashInBackground(trashRootFor(main, dir))).toEqual([]);
  });
});
