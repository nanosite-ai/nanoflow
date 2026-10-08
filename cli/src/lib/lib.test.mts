import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, fillTemplate, mergeConfig } from "./config.mjs";
import { bodyLinksTicket, prTitleProblems, titleFromCommits, withTicketRef } from "./conventional.mjs";
import { applyFlowResult, buildFlowQuery, ciRollup, type FlowWorktree } from "./flow.mjs";
import { slugFromRemote } from "./gh.mjs";
import type { RepoContext } from "./repo.mjs";
import { attachShotsToBody, shotRawUrl, shotsFolder } from "./shots.mjs";
import { envForSlot, nextFreeSlot, portOf, slotVars, slugify, ticketOf, upsertEnvText } from "./worktree.mjs";

const config = mergeConfig({
  services: [
    { name: "web", base: 5173, step: 10, open: true, start: { run: "npm run dev" } },
    { name: "api", base: 3001, step: 10, path: "/healthz" },
    { name: "worker", start: { run: "npm run worker" } },
  ],
  env: {
    export: { VITE_PORT: "{port:web}", API_URL: "{origin:api}" },
    worktree: { QUEUE_PREFIX: "q-{feature}" },
    files: { "api/.env": { PORT: "{port:api}" } },
  },
  github: { board: { owner: "acme", number: 3, statuses: { "in-progress": "Doing" } } },
});

describe("config", () => {
  test("merges over defaults; bad fields fall back", () => {
    expect(config.services.map((s) => s.name)).toEqual(["web", "api", "worker"]);
    expect(config.github.board?.statuses["in-progress"]).toBe("Doing");
    expect(config.github.board?.statuses.ready).toBe("Ready");
    expect(mergeConfig({ ticket: { branchPattern: "(" } }).ticket.branchPattern).toBe(DEFAULT_CONFIG.ticket.branchPattern);
    expect(mergeConfig({ worktree: { install: null } }).worktree.install).toBe(null);
  });

  test("templates fail loudly on a typo", () => {
    expect(fillTemplate("{port:web}", { "port:web": 5183 })).toBe("5183");
    expect(() => fillTemplate("{prot:web}", { "port:web": 5183 })).toThrow(/Unknown placeholder \{prot:web\}/);
  });
});

describe("slots", () => {
  test("ports, origins and env per slot", () => {
    expect(portOf(config.services[0], 2)).toBe(5193);
    expect(portOf(config.services[2], 2)).toBe(null);
    const vars = slotVars(config, 2, { feature: "12-x" });
    expect(envForSlot(config, 2, vars)).toEqual({ VITE_PORT: "5193", API_URL: "http://localhost:3021", QUEUE_PREFIX: "q-12-x" });
    expect(envForSlot(config, 0, slotVars(config, 0, { feature: "main" }))).toEqual({ VITE_PORT: "5173", API_URL: "http://localhost:3001" });
  });

  test("next free slot skips the main slot and used ones", () => {
    const meta = (slot: number) => ({ path: `/w${slot}`, meta: { feature: "f", slot, branch: "b" } });
    expect(nextFreeSlot(config, [meta(1), meta(3)])).toBe(2);
    expect(nextFreeSlot(config, [])).toBe(1);
  });

  test(".env upserts", () => {
    expect(upsertEnvText("A=1\nPORT=3001\n", { PORT: "3011", B: "2" })).toBe("A=1\nPORT=3011\nB=2\n");
  });

  test("names", () => {
    expect(slugify("Lease expires mid-post!")).toBe("lease-expires-mid-post");
    expect(slugify("Dark mode for the storefront")).toBe("dark-mode-storefront");
    expect(slugify("Cart total rounds to the wrong cent")).toBe("cart-total-rounds-wrong");
    expect(slugify("The end", 3)).toBe("end");
    expect(slugify("To be or not")).toBe("not");
    expect(slugify("of the")).toBe("of-the");
    expect(ticketOf(config, "feat/712-site-offline")).toBe(712);
    expect(ticketOf(config, "main", "repo-ads")).toBe(null);
  });
});

describe("PR titles", () => {
  test("conventional + ticket ref", () => {
    expect(prTitleProblems("feat(web): add csv export (#12)")).toEqual([]);
    expect(prTitleProblems("Add csv export").length).toBe(1);
    expect(prTitleProblems("feat: Add csv export.").length).toBe(1);
    expect(withTicketRef("fix: x", 12)).toBe("fix: x (#12)");
    expect(titleFromCommits(["chore: a", "feat(web): b", "fix: c"])).toBe("feat(web): b");
    expect(bodyLinksTicket("…\nCloses #12")).toBe(true);
  });
});

describe("screenshots", () => {
  test("folder, url, body section", () => {
    expect(shotsFolder(13, "feat/12-csv-export")).toBe("pr-13-csv-export");
    expect(shotRawUrl("acme/app", "assets/pr-screenshots", "pr-13-x/a b.png")).toBe("https://github.com/acme/app/raw/assets/pr-screenshots/pr-13-x/a%20b.png");
    expect(attachShotsToBody("## What\nx\n\n## Screenshots\n<!-- add -->\n\n## Test\ny", ["![a](u)"])).toBe("## What\nx\n\n## Screenshots\n\n![a](u)\n\n## Test\ny");
  });

  test("repo slug from a remote", () => {
    expect(slugFromRemote("git@github.com:acme/app.git")).toBe("acme/app");
    expect(slugFromRemote("https://github.com/acme/app/")).toBe("acme/app");
  });
});

describe("flow", () => {
  const tree = (over: Partial<FlowWorktree>): FlowWorktree => ({
    name: "app-12-x", path: "/d/app-12-x", branch: "feat/12-x", isMain: false, isCurrent: false, slot: 1, dirty: 0, ahead: 1,
    services: [], stack: null, ticket: { number: 12, title: null, url: "", state: null, status: null, worktree: "app-12-x" }, pr: null, ...over,
  });
  const repo = { config, mainRoot: "/d/app" } as unknown as RepoContext;

  test("one query, folded back into the worktrees and the board", () => {
    const trees = [tree({ isMain: true, branch: "main", ticket: null, name: "app" }), tree({})];
    const q = buildFlowQuery(trees);
    expect(q.match(/issue\(number:/g)?.length).toBe(1);
    expect(q.match(/pullRequests\(/g)?.length).toBe(1);
    const col = (name: string) => ({ nodes: [{ project: { number: 3, owner: { login: "acme" } }, fieldValueByName: { name } }] });
    const board = applyFlowResult(repo, trees, {
      open: { nodes: [{ number: 12, title: "x", url: "u", state: "OPEN", projectItems: col("Doing") }, { number: 5, title: "y", url: "u5", state: "OPEN", projectItems: col("Backlog") }] },
      t1: { number: 12, title: "csv export", url: "u12", state: "OPEN", projectItems: col("Doing") },
      p1: { nodes: [{ number: 13, url: "pr", state: "MERGED", commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] } }] },
    });
    expect(trees[1].ticket?.title).toBe("csv export");
    expect(trees[1].ticket?.status).toBe("Doing");
    expect(trees[1].pr).toEqual({ number: 13, url: "pr", state: "MERGED", ci: "pass", ciUrl: null });
    expect(board.map((t) => [t.number, t.worktree])).toEqual([[12, "app-12-x"]]);
  });

  test("CI rollup: fail beats pending beats pass", () => {
    expect(ciRollup([{ status: "IN_PROGRESS", detailsUrl: "p" }, { conclusion: "FAILURE", detailsUrl: "f" }])).toEqual({ ci: "fail", ciUrl: "f" });
    expect(ciRollup([{ state: "PENDING", targetUrl: "p" }]).ci).toBe("pending");
    expect(ciRollup([]).ci).toBe("none");
  });
});
