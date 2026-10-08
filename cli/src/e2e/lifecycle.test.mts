// The whole task lifecycle, end to end, through the built CLI: kickoff → worktree on its own ports → the app
// up and down → checks → PR with screenshots → CI → wrap-up → done → teardown. Runs on a throwaway repo with a
// bare origin, a real HTTP service, and a fake gh (fake-gh.mjs), so nothing touches GitHub.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "..", "..", "bin", "nanoflow.mjs");
const FAKE_GH = path.join(HERE, "fake-gh.mjs");

const ROOT = mkdtempSync(path.join(tmpdir(), "nanoflow-e2e-"));
const MAIN = path.join(ROOT, "demo");
const ORIGIN = path.join(ROOT, "origin.git");
const WT = path.join(ROOT, "demo-7-csv-export");
const LOG = path.join(ROOT, "gh-log.jsonl");
const FIXTURES = path.join(ROOT, "gh-fixtures.json");
// A port range of its own per run, so parallel runs and a real dev server don't collide.
const BASE = 20_000 + (process.pid % 1_000) * 20;
const SLOT1_PORT = BASE + 10;

const PR_URL = "https://github.com/acme/demo/pull/8";
const pr = (state: string): string => JSON.stringify({ number: 8, url: PR_URL, state });

interface Fixture {
  match: string[];
  stdout?: string;
  code?: number;
}

const FIXTURE_LIST: Fixture[] = [
  { match: ["--version"], stdout: "gh version 9.9.9 (fake)\n" },
  { match: ["auth", "status"] },
  { match: ["issue", "create"], stdout: "https://github.com/acme/demo/issues/7\n" },
  { match: ["issue", "view", "7"], stdout: JSON.stringify({ number: 7, title: "Csv export", state: "OPEN", url: "https://github.com/acme/demo/issues/7" }) },
  { match: ["pr", "list", "open"], stdout: "" },
  { match: ["pr", "list", "all"], stdout: pr("OPEN") },
  { match: ["pr", "list", "merged"], stdout: pr("MERGED") },
  { match: ["pr", "create"], stdout: `${PR_URL}\n` },
  { match: ["pr", "view", "8", "headRefName"], stdout: "feat/7-csv-export" },
  { match: ["pr", "view", "8", "body"], stdout: "## What & why\n\n- feat: csv export\n\nCloses #7\n" },
  // Real gh exits 1 when a check failed, and still prints the JSON.
  {
    match: ["pr", "checks", "8"],
    code: 1,
    stdout: JSON.stringify([
      { name: "test (ubuntu)", workflow: "CI", state: "SUCCESS", bucket: "pass", link: "https://github.com/acme/demo/actions/runs/98/job/1" },
      { name: "test (windows)", workflow: "CI", state: "FAILURE", bucket: "fail", link: "https://github.com/acme/demo/actions/runs/99/job/2" },
    ]),
  },
  { match: ["run", "view", "99"], stdout: "test (windows)\tRun tests\tError: expected 2 to be 3\n" },
  // The screenshots branch doesn't exist yet: nanoflow creates it through the API.
  { match: ["api", "repos/acme/demo/branches/assets%2Fpr-screenshots"], code: 1, stdout: "" },
  { match: ["api", "repos/acme/demo/git/trees"], stdout: "tree-sha" },
  { match: ["api", "repos/acme/demo/git/commits"], stdout: "commit-sha" },
  { match: ["api", "PUT"], stdout: "pr-8-csv-export/after.png" },
];

/** Never let a test rename the Claude Code session or terminal it runs under. */
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDECODE", "NANOFLOW_GH"]) delete env[k];
  return {
    ...env,
    NANOFLOW_GH: FAKE_GH,
    FAKE_GH_LOG: LOG,
    FAKE_GH_FIXTURES: FIXTURES,
    NO_COLOR: "1",
    GIT_AUTHOR_NAME: "nanoflow e2e",
    GIT_AUTHOR_EMAIL: "e2e@nanoflow.invalid",
    GIT_COMMITTER_NAME: "nanoflow e2e",
    GIT_COMMITTER_EMAIL: "e2e@nanoflow.invalid",
  };
};

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const nf = (cwd: string, ...args: string[]): Ran => {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, env: cleanEnv(), encoding: "utf8", timeout: 90_000 });
  return { code: res.status ?? 1, stdout: res.stdout, stderr: res.stderr, json: () => JSON.parse(res.stdout) };
};

const git = (cwd: string, ...args: string[]): string => {
  const res = spawnSync("git", args, { cwd, env: cleanEnv(), encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
};

/** The gh calls since the last read, each as its argv joined by spaces (plus its body/input file). */
let seen = 0;
const ghCalls = (): { line: string; body?: string; input?: string }[] => {
  const all = existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean) : [];
  const fresh = all.slice(seen).map((l) => JSON.parse(l) as { args: string[]; body?: string; input?: string });
  seen = all.length;
  return fresh.map((c) => ({ line: c.args.join(" "), body: c.body, input: c.input }));
};

const get = async (port: number): Promise<string | null> => {
  try {
    const res = await fetch(new URL(`http://localhost:${port}/`), { signal: AbortSignal.timeout(2_000) });
    return await res.text();
  } catch {
    return null;
  }
};

beforeAll(() => {
  writeFileSync(FIXTURES, JSON.stringify(FIXTURE_LIST, null, 2));
  git(ROOT, "init", "-q", "--bare", "-b", "main", ORIGIN);
  mkdirSync(MAIN);
  git(MAIN, "init", "-q", "-b", "main");
  mkdirSync(path.join(MAIN, ".claude"));
  writeFileSync(
    path.join(MAIN, ".claude", "nanoflow.json"),
    JSON.stringify({
      github: { repo: "acme/demo" },
      services: [{ name: "web", base: BASE, step: 10, path: "/", open: true, start: { run: "node server.mjs" } }],
      env: { export: { PORT: "{port:web}" } },
      worktree: { install: null },
      checks: { types: "node pass.mjs", tests: "node fail.mjs" },
      stack: { timeoutSeconds: 30 },
    }),
  );
  writeFileSync(path.join(MAIN, "server.mjs"), 'import http from "node:http";\nhttp.createServer((_q, r) => r.end(`hello from ${process.env.PORT}`)).listen(Number(process.env.PORT));\n');
  writeFileSync(path.join(MAIN, "pass.mjs"), "console.log('all good');\n");
  writeFileSync(path.join(MAIN, "fail.mjs"), "console.log('ran 3 tests');\nconsole.error('FAIL csv.test.ts: expected 2 to be 3');\nprocess.exit(1);\n");
  git(MAIN, "add", "-A");
  git(MAIN, "commit", "-q", "-m", "chore: initial");
  git(MAIN, "remote", "add", "origin", ORIGIN);
  git(MAIN, "push", "-q", "-u", "origin", "main");
});

afterAll(() => {
  nf(WT, "kill");
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

describe("the task lifecycle", { timeout: 120_000 }, () => {
  test("doctor: everything nanoflow relies on is there", () => {
    const res = nf(MAIN, "doctor", "--json");
    expect(res.code, res.stderr).toBe(0);
    expect(res.json().checks.find((c: { name: string }) => c.name === "GitHub repo").detail).toBe("acme/demo");
  });

  test("task start --new: issue, worktree on slot 1, opening comment", () => {
    const res = nf(MAIN, "task", "start", "--new", "Csv export", "--definition", "Export orders as CSV.", "--json");
    expect(res.code, res.stderr).toBe(0);
    expect(res.json()).toMatchObject({ issue: 7, branch: "feat/7-csv-export", title: "#7 · feat/7-csv-export · csv export" });
    expect(existsSync(path.join(WT, ".worktree.json"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(WT, ".worktree.json"), "utf8"))).toMatchObject({ slot: 1, feature: "7-csv-export" });
    const calls = ghCalls();
    const create = calls.find((c) => c.line.startsWith("issue create"));
    expect(create?.line).toContain("--title Csv export");
    expect(create?.line).toContain("--repo acme/demo");
    expect(create?.body).toContain("Export orders as CSV.");
    expect(calls.some((c) => c.line.startsWith("issue comment 7"))).toBe(true);
    // nanoflow's own files stay out of git.
    expect(git(WT, "status", "--porcelain")).toBe("");
  });

  test("env: the worktree's ports follow its slot", () => {
    const res = nf(WT, "env", "--json");
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.stringify(res.json())).toContain(String(SLOT1_PORT));
  });

  test("up --bg / status / logs / kill: the app runs on the slot's port and stops", async () => {
    const up = nf(WT, "up", "--bg", "--json");
    expect(up.code, up.stderr).toBe(0);
    expect(await get(SLOT1_PORT)).toBe(`hello from ${SLOT1_PORT}`);
    expect(nf(WT, "status", "--json").json().services[0]).toMatchObject({ name: "web", up: true });
    expect(nf(MAIN, "status", "--json").json().services[0]).toMatchObject({ up: false }); // main's slot is untouched
    expect(nf(WT, "up", "--bg").code).toBe(1); // refuses to start twice

    const kill = nf(WT, "kill", "--json");
    expect(kill.code, kill.stderr).toBe(0);
    expect(kill.json().killed.length).toBeGreaterThan(0);
    expect(await get(SLOT1_PORT)).toBeNull();
  });

  test("check: one line per check, only the failure's tail, exit 1", () => {
    const res = nf(WT, "check", "--json");
    expect(res.code).toBe(1);
    const { results } = res.json();
    expect(results.map((r: { name: string; ok: boolean }) => [r.name, r.ok])).toEqual([["types", true], ["tests", false]]);
    expect(results[1].output).toContain("expected 2 to be 3");
    expect(results[0].output).toBe("");
  });

  test("pr create --shots: pushes, Conventional title + (#7), Closes #7, screenshots embedded", () => {
    writeFileSync(path.join(WT, "csv.mjs"), "export const toCsv = (rows) => rows.join('\\n');\n");
    git(WT, "add", "-A");
    git(WT, "commit", "-q", "-m", "feat: csv export");
    const shot = path.join(ROOT, "after.png");
    writeFileSync(shot, "not really a png");

    const res = nf(WT, "pr", "create", "--shots", shot, "--json");
    expect(res.code, res.stderr).toBe(0);
    expect(res.json()).toMatchObject({ pr: 8, title: "feat: csv export (#7)", issue: 7 });
    expect(git(ORIGIN, "rev-parse", "feat/7-csv-export")).toBe(git(WT, "rev-parse", "HEAD")); // really pushed

    const calls = ghCalls();
    const create = calls.find((c) => c.line.startsWith("pr create"));
    expect(create?.line).toContain("--title feat: csv export (#7)");
    expect(create?.body).toContain("Closes #7");
    expect(calls.some((c) => c.line.includes("repos/acme/demo/git/refs") && c.line.includes("ref=refs/heads/assets/pr-screenshots"))).toBe(true);
    const put = calls.find((c) => c.line.includes("-X PUT"));
    expect(put?.line).toContain("repos/acme/demo/contents/pr-8-csv-export/after.png");
    expect(JSON.parse(put?.input ?? "{}")).toMatchObject({ branch: "assets/pr-screenshots", content: Buffer.from("not really a png").toString("base64") });
    const edit = calls.find((c) => c.line.startsWith("pr edit 8"));
    expect(edit?.body).toContain("## Screenshots");
    expect(edit?.body).toContain("https://github.com/acme/demo/raw/assets/pr-screenshots/pr-8-csv-export/after.png");
  });

  test("pr create refuses a non-Conventional title", () => {
    const res = nf(WT, "pr", "create", "--title", "Added CSV export.", "--dry");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("not a valid Conventional Commit");
  });

  test("shots --attach: uploads and adds them under ## Screenshots", () => {
    const shot = path.join(ROOT, "before.png");
    writeFileSync(shot, "png bytes");
    const res = nf(WT, "shots", "8", shot, "--attach", "--json");
    expect(res.code, res.stderr).toBe(0);
    expect(res.json()[0].repoPath).toBe("pr-8-csv-export/before.png");
    const edit = ghCalls().find((c) => c.line.startsWith("pr edit 8"));
    expect(edit?.body).toContain("Closes #7");
    expect(edit?.body).toContain("pr-8-csv-export/before.png");
  });

  test("ci --failed-log: reads checks even though gh exits 1, prints the failing log tail", () => {
    const res = nf(WT, "ci", "--failed-log", "--json");
    expect(res.code).toBe(1);
    const out = res.json();
    expect(out.pr).toBe(8);
    expect(out.failedRuns).toEqual(["99"]);
    expect(out.logs["99"]).toContain("expected 2 to be 3");
  });

  test("ci --rerun-failed --dry changes nothing", () => {
    nf(WT, "ci", "--rerun-failed", "--dry");
    expect(ghCalls().some((c) => c.line.startsWith("run rerun"))).toBe(false);
  });

  test("flow --local: every worktree with its ticket and slot", () => {
    const res = nf(MAIN, "flow", "--json", "--local");
    expect(res.code, res.stderr).toBe(0);
    const wt = res.json().worktrees.find((w: { branch: string }) => w.branch === "feat/7-csv-export");
    expect(wt).toMatchObject({ slot: 1, ticket: { number: 7 } });
    expect(wt.services[0]).toMatchObject({ name: "web", port: SLOT1_PORT, isUp: false });
  });

  test("summary: the wrap-up footer from live state", () => {
    const res = nf(WT, "summary", "--what", "Orders export as CSV.", "--next", "review + merge", "--json");
    expect(res.code, res.stderr).toBe(0);
    const { text } = res.json();
    expect(text).toContain("[worktree: demo-7-csv-export] [branch: feat/7-csv-export]");
    expect(text).toContain(`[PR: [#8](${PR_URL})]`);
    expect(text).toContain("[ticket: [#7](https://github.com/acme/demo/issues/7)] [done: no]");
    expect(text).toContain(`**Local:** http://localhost:${SLOT1_PORT}`);
  });

  test("task done: the merged PR gets its ✓", () => {
    const res = nf(WT, "task", "done", "--json");
    expect(res.code, res.stderr).toBe(0);
    expect(res.json().title).toBe("#7 · feat/7-csv-export · csv export · PR #8 ✓");
  });

  test("wt remove: deletes the worktree and its branch", () => {
    const res = nf(MAIN, "wt", "remove", "7-csv-export", "--delete-branch", "--yes");
    expect(res.code, res.stderr).toBe(0);
    expect(existsSync(WT)).toBe(false);
    expect(git(MAIN, "branch", "--list", "feat/7-csv-export")).toBe("");
    expect(res.stdout).toContain("Agent cleanup");
  });

  test("wt remove refuses unpushed work", () => {
    expect(nf(MAIN, "wt", "create", "9-scratch", "--json").code).toBe(0);
    const dir = path.join(ROOT, "demo-9-scratch");
    writeFileSync(path.join(dir, "wip.txt"), "wip");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "wip");
    const res = nf(MAIN, "wt", "remove", "9-scratch", "--yes");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("commits on no remote");
    expect(existsSync(dir)).toBe(true);
  });
});

describe("init on a repo whose package lives in a subfolder", { timeout: 60_000 }, () => {
  test("finds the scripts, adds no app service, and doctor passes", () => {
    const repo = path.join(ROOT, "lib");
    mkdirSync(path.join(repo, "cli"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", "https://github.com/acme/lib.git");
    writeFileSync(path.join(repo, "cli", "package.json"), JSON.stringify({ scripts: { tsc: "tsc --noEmit", test: "vitest run" } }));
    writeFileSync(path.join(repo, "cli", "package-lock.json"), "{}");

    const init = nf(repo, "init", "--team", "--json");
    expect(init.code, init.stderr).toBe(0);
    const config = JSON.parse(readFileSync(path.join(repo, ".claude", "nanoflow.json"), "utf8"));
    expect(config.checks).toEqual({ typecheck: "cd cli && npm run tsc", test: "cd cli && npm test" });
    expect(config.services).toEqual([]);
    expect(config.worktree.install).toBe("cd cli && npm install");
    expect(config.actions.startDev).toBeNull();
    const settings = JSON.parse(readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.enabledPlugins["nanoflow@nanoflow"]).toBe(true);

    const doctor = nf(repo, "doctor", "--json");
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(nf(repo, "init").code).toBe(1); // never overwrites without --force
  });
});
