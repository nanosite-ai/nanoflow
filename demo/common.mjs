// What the demo is made of, and the environment that points nanoflow at the fake GitHub.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Short and neutral, so no home folder or user name ever shows in a path. */
export const DEFAULT_DIR = process.platform === "win32" ? "C:\\demo" : "/tmp/demo";

export const parseDir = (argv) => {
  const i = argv.indexOf("--dir");
  return path.resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : DEFAULT_DIR);
};

/** The nanoflow CLI: this checkout's build when there is one, else the global install. */
export const nanoflowBin = () => {
  const local = path.resolve(HERE, "..", "cli", "bin", "nanoflow.mjs");
  if (existsSync(path.resolve(HERE, "..", "cli", "dist", "cli.mjs"))) return local;
  const root = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).stdout.trim();
  const global = path.join(root, "@nanosite", "nanoflow", "bin", "nanoflow.mjs");
  if (existsSync(global)) return global;
  throw new Error("nanoflow not found: run `npm run build` in cli/, or `npm i -g @nanosite/nanoflow`.");
};

/** The demo's env: gh is the fake, the author is made up, and no Claude session of yours gets renamed. */
export const demoEnv = (dir) => {
  const env = { ...process.env };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDECODE"]) delete env[k];
  return {
    ...env,
    NANOFLOW_GH: path.join(HERE, "fake-github.mjs"),
    FAKE_GITHUB_STATE: path.join(dir, "github.json"),
    NO_COLOR: "1",
    GIT_AUTHOR_NAME: "Dana Dev",
    GIT_AUTHOR_EMAIL: "dana@acme.test",
    GIT_COMMITTER_NAME: "Dana Dev",
    GIT_COMMITTER_EMAIL: "dana@acme.test",
  };
};

export const DEMO = {
  owner: "acme",
  slug: "acme/shop",
  repoDir: "shop",
  webBase: 4100,
  apiBase: 4600,

  issues: [
    { number: 21, title: "Dark mode for the storefront", state: "OPEN", status: "Ready" },
    { number: 22, title: "Email receipts after purchase", state: "OPEN", status: "Ready" },
    { number: 15, title: "Cart total rounds to the wrong cent", state: "OPEN", status: "In progress" },
    { number: 12, title: "Apple Pay at checkout", state: "OPEN", status: "In progress" },
    { number: 14, title: "Export orders as CSV", state: "OPEN", status: "In review" },
    { number: 23, title: "Low-stock alerts for inventory", state: "OPEN", status: "Backlog" },
    { number: 9, title: "Product search with filters", state: "CLOSED", status: "Done" },
  ],

  prs: [
    { number: 17, branch: "feat/9-product-search", title: "feat(search): product search with filters (#9)", state: "MERGED", ci: "pass" },
    { number: 18, branch: "feat/12-apple-pay", title: "feat(checkout): apple pay (#12)", state: "OPEN", ci: "pass" },
    { number: 19, branch: "feat/14-orders-csv", title: "feat(orders): export orders as csv (#14)", state: "OPEN", ci: "fail" },
  ],

  worktrees: [
    {
      feature: "12-apple-pay", ticket: 12, slot: 1, short: "apple pay", pushed: true, running: true,
      note: "PR #18, CI green, dev servers running",
      commits: [
        ["feat(checkout): apple pay button", { "src/checkout.ts": "export const paymentMethods = [\"card\", \"apple-pay\"] as const;\n" }],
        ["test(checkout): pays with apple pay", { "src/checkout.test.ts": "// pays with Apple Pay\n" }],
      ],
    },
    {
      feature: "14-orders-csv", ticket: 14, slot: 2, short: "orders csv", pushed: true,
      note: "PR #19, CI red (a Playwright test)",
      commits: [
        ["feat(orders): csv export", { "src/orders-csv.ts": "export const toCsv = (rows: string[][]): string => rows.map((r) => r.join(\",\")).join(\"\\n\");\n" }],
        ["feat(orders): download button", { "src/orders-page.ts": "// Download CSV\n" }],
        ["test(orders): csv export e2e", { "e2e/orders.spec.ts": "// exports orders\n" }],
      ],
    },
    {
      feature: "15-cart-rounding", ticket: 15, slot: 3, short: "cart rounding",
      note: "in progress, 2 files changed, no PR yet",
      commits: [["test(cart): reproduce the rounding bug", { "src/cart.test.ts": "// 0.1 + 0.2 should total 0.30\n" }]],
      dirty: {
        "src/cart.ts": "export const cartTotal = (lines: { price: number; qty: number }[]): number =>\n  Math.round(lines.reduce((sum, l) => sum + l.price * l.qty, 0) * 100) / 100;\n",
        "src/money.ts": "export const cents = (n: number): number => Math.round(n * 100);\n",
      },
    },
    {
      feature: "9-product-search", ticket: 9, slot: 4, short: "product search", pushed: true,
      note: "PR #17 merged: ready to tear down",
      commits: [["feat(search): filters", { "src/search.ts": "// search with filters\n" }]],
    },
  ],
};
