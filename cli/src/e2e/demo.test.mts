// The demo kit (demo/) keeps working: setup builds the repo, and nf flow shows the story through the fake GitHub.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.resolve(HERE, "..", "..", "..", "demo");
const BIN = path.resolve(HERE, "..", "..", "bin", "nanoflow.mjs");
const DIR = path.join(mkdtempSync(path.join(tmpdir(), "nanoflow-demo-")), "demo");

const env = (): NodeJS.ProcessEnv => {
  const e = { ...process.env, NANOFLOW_GH: path.join(DEMO, "fake-github.mjs"), FAKE_GITHUB_STATE: path.join(DIR, "github.json"), NO_COLOR: "1" };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDECODE"]) delete e[k];
  return e;
};
const node = (cwd: string, ...args: string[]) => spawnSync(process.execPath, args, { cwd, env: env(), encoding: "utf8", timeout: 90_000 });

afterAll(() => rmSync(path.dirname(DIR), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }));

describe("demo kit", { timeout: 120_000 }, () => {
  test("setup builds the shop, and nf flow tells its story", () => {
    const setup = node(DEMO, "setup.mjs", "--dir", DIR, "--no-servers");
    expect(setup.status, setup.stderr).toBe(0);

    const flow = node(path.join(DIR, "shop"), BIN, "flow", "--json");
    expect(flow.status, flow.stderr).toBe(0);
    const snap = JSON.parse(flow.stdout);
    const byTicket = Object.fromEntries(snap.worktrees.filter((w: { ticket: unknown }) => w.ticket).map((w: { ticket: { number: number } }) => [w.ticket.number, w]));
    expect(snap.worktrees).toHaveLength(5);
    expect(byTicket[12]).toMatchObject({ slot: 1, ticket: { title: "Apple Pay at checkout", status: "In progress" }, pr: { number: 18, ci: "pass" } });
    expect(byTicket[14].pr).toMatchObject({ number: 19, ci: "fail" });
    expect(byTicket[15]).toMatchObject({ dirty: 2, pr: null });
    expect(byTicket[9].pr).toMatchObject({ number: 17, state: "MERGED" });
    expect(snap.board.map((t: { number: number }) => t.number)).toEqual([21, 22, 15, 12, 14]);
  });

  test("the director moves the story: merge a PR, its ticket closes", () => {
    expect(node(DEMO, "director.mjs", "--dir", DIR, "merge", "18").status).toBe(0);
    const snap = JSON.parse(node(path.join(DIR, "shop"), BIN, "flow", "--json").stdout);
    const apple = snap.worktrees.find((w: { ticket?: { number: number } }) => w.ticket?.number === 12);
    expect(apple.pr.state).toBe("MERGED");
    expect(apple.ticket.status).toBe("Done");
  });
});
