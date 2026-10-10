#!/usr/bin/env node
// Builds a throwaway "Acme Shop" repo for recording nanoflow: four worktrees in different states, dev servers
// running on their slot ports, and a fake GitHub (issues, board, PRs, CI) behind it. Nothing personal shows:
// the paths, the git author, the org and the repo are all made up.
//
//   node demo/setup.mjs [--dir C:\demo] [--force] [--no-servers]
//   node demo/launch.mjs [--dir C:\demo]            → Claude Code inside it, nanoflow loaded
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoEnv, DEMO, nanoflowBin, parseDir } from "./common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DIR = parseDir(argv);
const SHOP = path.join(DIR, DEMO.repoDir);
const ORIGIN = path.join(DIR, "origin.git");
const env = demoEnv(DIR);

const sh = (cwd, cmd, args, { allowFail = false } = {}) => {
  const res = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (res.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(" ")} (in ${cwd}) failed:\n${res.stderr || res.stdout}`);
  return res.stdout.trim();
};
const git = (cwd, ...args) => sh(cwd, "git", args);
const nf = (cwd, ...args) => sh(cwd, process.execPath, [nanoflowBin(), ...args]);
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const commit = (cwd, message, files) => {
  for (const [rel, text] of Object.entries(files)) write(path.join(cwd, rel), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
};

if (existsSync(DIR)) {
  if (!argv.includes("--force")) throw new Error(`${DIR} exists. Re-run with --force to rebuild it (stops its dev servers and deletes it).`);
  // Stop the dev servers of every checkout, the ones made on camera included, so no file stays locked.
  // Best-effort: a half-deleted demo is no repo any more.
  for (const name of readdirSync(DIR).filter((n) => n === DEMO.repoDir || n.startsWith(`${DEMO.repoDir}-`))) {
    spawnSync(process.execPath, [nanoflowBin(), "kill"], { cwd: path.join(DIR, name), env });
  }
  rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
mkdirSync(DIR, { recursive: true });
console.log(`▶ building the demo in ${DIR}`);

// ─── The repo ────────────────────────────────────────────────────────────────

git(DIR, "init", "-q", "--bare", "-b", "main", ORIGIN);
mkdirSync(SHOP);
git(SHOP, "init", "-q", "-b", "main");

const server = (kind) => `// The Acme Shop ${kind}, just enough to answer on its port.
import http from "node:http";

const port = Number(process.env.${kind === "storefront" ? "WEB_PORT" : "API_PORT"});
http
  .createServer((_req, res) => {
    ${kind === "storefront"
      ? 'res.setHeader("content-type", "text/html");\n    res.end(`<h1>Acme Shop</h1><p>storefront on :${port}</p>`);'
      : 'res.setHeader("content-type", "application/json");\n    res.end(JSON.stringify({ ok: true, port }));'}
  })
  .listen(port, () => console.log(\`${kind} ready on http://localhost:\${port}\`));
`;

const check = `// Fast, realistic-looking checks for the demo.
const kind = process.argv[2];
const lines = {
  types: ["tsc --noEmit", "checked 48 files"],
  lint: ["eslint .", "0 problems"],
  test: ["vitest run", " ✓ cart.test.ts (12 tests)", " ✓ checkout.test.ts (9 tests)", " Test Files  2 passed (2)"],
}[kind] ?? [];
for (const line of lines) console.log(line);
`;

const config = {
  $schema: "https://raw.githubusercontent.com/nanosite-ai/nanoflow/main/nanoflow.schema.json",
  mainBranch: "main",
  github: { repo: DEMO.slug, board: { owner: DEMO.owner, number: 1 } },
  provider: { snapshot: [process.execPath, nanoflowBin(), "flow", "--json"], local: [process.execPath, nanoflowBin(), "flow", "--json", "--local"] },
  poll: { localSeconds: 5, githubSeconds: 60 },
  // The pane's buttons run argv directly, so they call node + the CLI (no .cmd shims on Windows).
  actions: {
    pickUp: { label: "Pick up", prompt: "Pick up ticket #{ticket} ({title}) in the worktree at {path}: `nf board set {ticket} in-progress`." },
    teardown: { label: "Teardown", run: [process.execPath, nanoflowBin(), "wt", "remove", "{feature}", "--delete-branch", "--yes"], cwd: "main", confirm: true },
    startTask: { label: "Start", prompt: "Start ticket #{ticket} ({title}) with `nf task start {ticket}`." },
    newTicket: { label: "Create", run: [process.execPath, nanoflowBin(), "ticket", "new", "{title}"], cwd: "main" },
  },
  services: [
    { name: "web", base: DEMO.webBase, step: 10, path: "/", open: true, start: { run: "node dev/web.mjs" } },
    { name: "api", base: DEMO.apiBase, step: 10, path: "/health", start: { run: "node dev/api.mjs" } },
  ],
  env: { export: { WEB_PORT: "{port:web}", API_PORT: "{port:api}" } },
  worktree: { copy: [], install: null },
  checks: { types: "node dev/check.mjs types", lint: "node dev/check.mjs lint", test: "node dev/check.mjs test" },
  stack: { timeoutSeconds: 20 },
};

commit(SHOP, "chore: acme shop", {
  "README.md": "# Acme Shop\n\nThe storefront and its API.\n",
  "package.json": `${JSON.stringify({ name: "acme-shop", private: true, type: "module", scripts: { dev: "node dev/web.mjs", test: "node dev/check.mjs test" } }, null, 2)}\n`,
  "dev/web.mjs": server("storefront"),
  "dev/api.mjs": server("api"),
  "dev/check.mjs": check,
  "src/cart.ts": "export const cartTotal = (lines: { price: number; qty: number }[]): number =>\n  lines.reduce((sum, l) => sum + l.price * l.qty, 0);\n",
  "src/checkout.ts": "export const paymentMethods = [\"card\"] as const;\n",
  "src/orders.ts": "export interface Order {\n  id: string;\n  total: number;\n}\n",
  ".claude/nanoflow.json": `${JSON.stringify(config, null, 2)}\n`,
  // Recording shouldn't stop for permission prompts on the demo's own commands.
  ".claude/settings.json": `${JSON.stringify({ permissions: { allow: [...["nf", "nanoflow", "git"].flatMap((cmd) => [`Bash(${cmd}:*)`, `PowerShell(${cmd}:*)`]), "Edit", "Write"] } }, null, 2)}\n`,
  ".gitignore": "node_modules/\n",
  // So natural prompts ("pick up the dark mode ticket") map to nanoflow, as in a real repo that uses it.
  "CLAUDE.md": [
    "# Acme Shop",
    "",
    "We work ticket-first with the nanoflow CLI (`nf`). Use it for every step, and keep replies to one short line.",
    "",
    "- Find a ticket: `nf board list ready`. Pick it up: `nf task start <n>` (it creates the worktree), then work inside that worktree.",
    "- Before a PR: commit, then `nf check`.",
    "- Open the PR: `nf pr create`, then `nf ci --watch`.",
    "",
  ].join("\n"),
});
git(SHOP, "remote", "add", "origin", ORIGIN);
git(SHOP, "push", "-q", "-u", "origin", "main");

// ─── Worktrees, each at a different point of its task ────────────────────────

for (const wt of DEMO.worktrees) {
  nf(SHOP, "wt", "create", wt.feature, "--slot", String(wt.slot));
  const dir = path.join(DIR, `${DEMO.repoDir}-${wt.feature}`);
  const branch = `feat/${wt.feature}`;
  git(SHOP, "config", `branch.${branch}.description`, `#${wt.ticket} · ${branch} · ${wt.short}`);
  for (const [message, files] of wt.commits) commit(dir, message, files);
  if (wt.pushed) git(dir, "push", "-q", "-u", "origin", branch);
  for (const [rel, text] of Object.entries(wt.dirty ?? {})) write(path.join(dir, rel), text);
  console.log(`✔ ${path.basename(dir)}  slot ${wt.slot}  ${wt.note}`);
}

// ─── The fake GitHub behind it ───────────────────────────────────────────────

const now = Date.now();
const github = {
  repo: DEMO.slug,
  next: 24,
  issues: DEMO.issues.map((i, k) => ({ ...i, updated: now - k * 60_000 })),
  prs: DEMO.prs.map((p) => ({ ...p, ciStartedAt: now })),
};
writeFileSync(path.join(DIR, "github.json"), `${JSON.stringify(github, null, 2)}\n`);

// ─── Dev servers: main and the Apple Pay worktree are running ────────────────

if (!argv.includes("--no-servers")) {
  for (const dir of [SHOP, ...DEMO.worktrees.filter((w) => w.running).map((w) => path.join(DIR, `${DEMO.repoDir}-${w.feature}`))]) {
    nf(dir, "up", "--bg");
    console.log(`✔ dev servers up in ${path.basename(dir)}`);
  }
}

console.log(`
Ready. Start recording with:

  node ${path.relative(process.cwd(), path.join(HERE, "launch.mjs")) || "demo/launch.mjs"}${argv.includes("--dir") ? ` --dir ${DIR}` : ""}

Move the story along from a second terminal (see demo/README.md):

  node ${path.join(HERE, "director.mjs")}${argv.includes("--dir") ? ` --dir ${DIR}` : ""} show
`);
