// The whole task lifecycle, end to end, through the built CLI: kickoff → worktree on its own ports → the app
// up and down → checks → PR with screenshots → CI → wrap-up → done → teardown. Runs on a throwaway repo with a
// bare origin, a real HTTP service, and a fake gh (fake-gh.mjs), so nothing touches GitHub.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "..", "..", "bin", "nanoflow.mjs");
const FAKE_GH = path.join(HERE, "fake-gh.mjs");
const FAKE_JIRA = path.join(HERE, "fake-jira.mjs");
const FAKE_ACLI = path.join(HERE, "fake-acli.mjs");

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
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDECODE", "NANOFLOW_GH", "NANOFLOW_ACLI"]) delete env[k];
  return {
    ...env,
    // Session titles and anything else nanoflow keeps per user go here, never to the real ~/.claude.
    CLAUDE_CONFIG_DIR: path.join(ROOT, "claude-config"),
    NANOFLOW_GH: FAKE_GH,
    // acli is "installed" but logged out unless a test logs it in (never the real one on this machine).
    NANOFLOW_ACLI: FAKE_ACLI,
    FAKE_ACLI_STATE: path.join(ROOT, "acli-state.json"),
    FAKE_ACLI_LOG: path.join(ROOT, "acli-log.jsonl"),
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

const nfWith = (opts: { env?: NodeJS.ProcessEnv; input?: string }, cwd: string, ...args: string[]): Ran => {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...cleanEnv(), ...opts.env }, input: opts.input, encoding: "utf8", timeout: 90_000 });
  return { code: res.status ?? 1, stdout: res.stdout, stderr: res.stderr, json: () => JSON.parse(res.stdout) };
};
const nf = (cwd: string, ...args: string[]): Ran => nfWith({}, cwd, ...args);

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

  test("task pr: title gets the PR, and says so honestly when there is no board", () => {
    const res = nf(WT, "task", "pr", "8");
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain("#7: no board configured, nothing to move");
    expect(res.stdout).toContain("#7 · feat/7-csv-export · csv export · PR #8");
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

describe("tickets in Jira, acli logged out (ticket.tracker: jira)", { timeout: 120_000 }, () => {
  const repo = path.join(ROOT, "web");
  const wt = path.join(ROOT, "web-ED-15914-system-check");
  const wt2 = path.join(ROOT, "web-ED-15915-stale-license-warning-reactivation");
  const JIRA_LOG = path.join(ROOT, "jira-log.jsonl");
  let jiraServer: ChildProcess | undefined;
  let JIRA = "";

  /** The Jira requests since the last read, as "METHOD /path" (plus the body). */
  let jiraSeen = 0;
  const jiraCalls = (): { line: string; body?: any }[] => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const all = existsSync(JIRA_LOG) ? readFileSync(JIRA_LOG, "utf8").split("\n").filter(Boolean) : [];
    const fresh = all.slice(jiraSeen).map((l) => JSON.parse(l) as { method: string; path: string; body?: unknown });
    jiraSeen = all.length;
    return fresh.map((c) => ({ line: `${c.method} ${c.path}`, body: c.body }));
  };

  beforeAll(async () => {
    jiraServer = spawn(process.execPath, [FAKE_JIRA, JIRA_LOG], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<string>((resolve) => jiraServer?.stdout?.once("data", (d: Buffer) => resolve(d.toString().trim())));
    JIRA = `http://127.0.0.1:${port}`;

    const origin = path.join(ROOT, "web.git");
    git(ROOT, "init", "-q", "--bare", "-b", "develop", origin);
    mkdirSync(path.join(repo, ".claude"), { recursive: true });
    git(repo, "init", "-q", "-b", "develop");
    writeFileSync(
      path.join(repo, ".claude", "nanoflow.json"),
      JSON.stringify({
        mainBranch: "develop",
        github: { repo: "acme/demo", board: { owner: "acme", number: 3 } },
        ticket: { tracker: "jira", keyPattern: "ED-\\d+", types: ["feat", "fix", "chore"] },
        jira: { site: JIRA },
        worktree: { branch: "{type}/{feature}", install: null },
        pr: { ticketRef: "scope" },
      }),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "chore: initial");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "-u", "origin", "develop");
    ghCalls();
  });

  afterAll(() => {
    jiraServer?.kill();
  });

  test("not logged in: task start <key> --title still works, with a typed branch and no GitHub issue calls", () => {
    expect(nf(repo, "task", "start", "ED-15914").stderr).toContain("Can't read ED-15914 (acli is not logged in");
    expect(nf(repo, "task", "start", "--new", "x").stderr).toContain("Creating a Jira ticket needs Jira access");

    const res = nf(repo, "task", "start", "ed-15914", "--title", "system check polling", "--slug", "system-check", "--type", "fix", "--json");
    expect(res.code, res.stderr).toBe(0);
    expect(res.json()).toMatchObject({ issue: "ED-15914", branch: "fix/ED-15914-system-check", title: "ED-15914 · fix/ED-15914-system-check · system check polling" });
    expect(existsSync(wt)).toBe(true);
    expect(ghCalls().filter((c) => c.line.startsWith("issue") || c.line.startsWith("project"))).toEqual([]);
    expect(jiraCalls()).toEqual([]);
  });

  test("pr create: the key as the title's scope, the Jira link in the body", () => {
    writeFileSync(path.join(wt, "poll.mjs"), "export const poll = true;\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "fix: poll the system check");
    const res = nf(wt, "pr", "create", "--json");
    expect(res.code, res.stderr).toBe(0);
    expect(res.json()).toMatchObject({ title: "fix(ED-15914): poll the system check", issue: "ED-15914" });
    const create = ghCalls().find((c) => c.line.startsWith("pr create"));
    expect(create?.body).toContain(`[ED-15914](${JIRA}/browse/ED-15914)`);
    expect(create?.body).not.toContain("Closes #");
    expect(res.json().ticketNote).toContain("ED-15914: not moved in Jira (acli is not logged in");
  });

  test("flow --local and summary name the key and link Jira", () => {
    const flow = nf(repo, "flow", "--json", "--local");
    expect(flow.code, flow.stderr).toBe(0);
    const tree = flow.json().worktrees.find((w: { branch: string }) => w.branch === "fix/ED-15914-system-check");
    expect(tree.ticket).toMatchObject({ number: 15914, key: "ED-15914", url: `${JIRA}/browse/ED-15914` });
    const summary = nf(wt, "summary", "--what", "x", "--json");
    expect(summary.json().text).toContain(`[ticket: [ED-15914](${JIRA}/browse/ED-15914)]`);
  });

});

describe("Jira through acli (the way GitHub goes through gh)", { timeout: 120_000 }, () => {
  const repo = path.join(ROOT, "app");
  const wt = path.join(ROOT, "app-ED-15915-stale-license-warning-reactivation");
  const ACLI_LOG = path.join(ROOT, "acli-log.jsonl");
  let jiraServer: ChildProcess | undefined;
  let env: NodeJS.ProcessEnv = {};

  /** The acli calls since the last read, each as its argv joined by spaces. */
  let acliSeen = 0;
  const acliCalls = (): string[] => {
    const all = existsSync(ACLI_LOG) ? readFileSync(ACLI_LOG, "utf8").split("\n").filter(Boolean) : [];
    const fresh = all.slice(acliSeen).map((l) => (JSON.parse(l) as { args: string[] }).args.join(" "));
    acliSeen = all.length;
    return fresh;
  };
  const run = (cwd: string, ...args: string[]): Ran => nfWith({ env }, cwd, ...args);

  beforeAll(async () => {
    jiraServer = spawn(process.execPath, [FAKE_JIRA, path.join(ROOT, "jira-log-acli.jsonl")], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<string>((resolve) => jiraServer?.stdout?.once("data", (d: Buffer) => resolve(d.toString().trim())));
    const JIRA = `http://127.0.0.1:${port}`;
    env = { FAKE_ACLI_JIRA: JIRA };

    const origin = path.join(ROOT, "app.git");
    git(ROOT, "init", "-q", "--bare", "-b", "develop", origin);
    mkdirSync(path.join(repo, ".claude"), { recursive: true });
    git(repo, "init", "-q", "-b", "develop");
    writeFileSync(
      path.join(repo, ".claude", "nanoflow.json"),
      JSON.stringify({
        mainBranch: "develop",
        github: { repo: "acme/demo" },
        ticket: { tracker: "jira", keyPattern: "ED-\\d+", types: ["feat", "fix", "chore"] },
        jira: { site: JIRA },
        worktree: { branch: "{type}/{feature}", install: null },
        pr: { ticketRef: "scope" },
      }),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "chore: initial");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "-u", "origin", "develop");
  });

  afterAll(() => {
    jiraServer?.kill();
  });

  test("jira login runs acli's browser login; whoami and doctor then go through acli", () => {
    const login = run(repo, "jira", "login", "--json");
    expect(login.code, login.stderr).toBe(0);
    expect(login.json()).toMatchObject({ user: "e2e@nanoflow.invalid" });
    expect(acliCalls()).toContain("jira auth login --web");
    expect(run(repo, "jira", "whoami", "--json").json()).toMatchObject({ user: "e2e@nanoflow.invalid" });
    expect(run(repo, "doctor", "--json").json().checks.find((c: { name: string }) => c.name === "Jira").ok).toBe(true);
  });

  test("task start <key>: title from acli, → In Progress through acli, branch comment", () => {
    expect(run(repo, "task", "start", "ED-15916").stderr).toContain("ED-15916 is Done");
    expect(run(repo, "task", "start", "ED-99999").stderr).toContain("Issue does not exist");
    acliCalls();
    const res = run(repo, "task", "start", "ED-15915", "--type", "fix", "--json");
    expect(res.code, res.stderr).toBe(0);
    expect(res.json()).toMatchObject({ issue: "ED-15915", branch: "fix/ED-15915-stale-license-warning-reactivation", ticketNote: "ED-15915 → In Progress" });
    const calls = acliCalls();
    expect(calls).toContain("jira workitem view ED-15915 --fields key,summary,status --json");
    expect(calls).toContain("jira workitem transition --key ED-15915 --status In Progress --yes");
    expect(calls).toContain("jira workitem comment create --key ED-15915 --body Starting work on branch fix/ED-15915-stale-license-warning-reactivation.");
  });

  test("flow: titles and statuses from one acli search", () => {
    acliCalls();
    const tree = run(repo, "flow", "--json").json().worktrees.find((w: { branch: string }) => w.branch?.startsWith("fix/ED-15915"));
    expect(tree.ticket).toMatchObject({ key: "ED-15915", title: "Stale license warning after reactivation", status: "In Progress", state: "OPEN" });
    expect(acliCalls().filter((c) => c.startsWith("jira workitem search"))).toEqual(["jira workitem search --jql key in (ED-15915) --fields key,summary,status --limit 100 --json"]);
  });

  test("pr create → In Review; task done → Done; a missing transition is reported, not thrown", () => {
    writeFileSync(path.join(wt, "license.mjs"), "export const fresh = true;\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "fix: clear the stale license warning");
    const pr = run(wt, "pr", "create", "--json");
    expect(pr.code, pr.stderr).toBe(0);
    expect(pr.json().ticketNote).toBe("ED-15915 → In Review");
    expect(run(wt, "task", "done", "--json").json().ticketNote).toBe("ED-15915 → Done");

    // The worktree reads its own checked-out nanoflow.json first.
    writeFileSync(path.join(wt, ".claude", "nanoflow.json"), readFileSync(path.join(wt, ".claude", "nanoflow.json"), "utf8").replace('"jira":{', '"jira":{"statuses":{"done":"Shipped"},'));
    const odd = run(wt, "task", "done", "--json");
    expect(odd.code, odd.stderr).toBe(0);
    expect(odd.json().ticketNote).toContain('ED-15915: not moved from Done to "Shipped"');
  });

  test("ticket new creates the work item through acli and reads its key", () => {
    acliCalls();
    const res = run(repo, "ticket", "new", "Export the audit log", "--type", "feat", "--definition", "Admins export the log.", "--json");
    expect(res.code, res.stderr).toBe(0);
    expect(res.json().key).toMatch(/^ED-16\d{3}$/);
    const create = acliCalls().find((c) => c.startsWith("jira workitem create"));
    expect(create).toContain("--project ED --type Task --summary Export the audit log --description Definition\nAdmins export the log.");
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
    expect(config.actions.pickUp.prompt).toContain("nanoflow board set {ticket} in-progress");
    const settings = JSON.parse(readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.enabledPlugins["nanoflow@nanoflow"]).toBe(true);

    const doctor = nf(repo, "doctor", "--json");
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(nf(repo, "init").code).toBe(1); // never overwrites without --force
  });
});
