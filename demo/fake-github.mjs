#!/usr/bin/env node
// A small, stateful stand-in for GitHub, spoken through the gh CLI's argv (wired in with NANOFLOW_GH). It
// keeps a demo repo's issues, board columns, PRs and CI in one JSON file (FAKE_GITHUB_STATE), so nanoflow
// shows a believable, moving workflow on camera without anyone's real account, org or repos.
//
// As gh:      NANOFLOW_GH=demo/fake-github.mjs nf …        (nanoflow runs `node fake-github.mjs <gh args>`)
// Directing:  node demo/fake-github.mjs demo <command>     (see DIRECTOR below)
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const STATE_FILE = process.env.FAKE_GITHUB_STATE;
if (!STATE_FILE || !existsSync(STATE_FILE)) {
  process.stderr.write("fake-github: FAKE_GITHUB_STATE must point at the demo's github.json (run demo/setup.mjs)\n");
  process.exit(1);
}
const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
const save = () => writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

const OWNER = state.repo.split("/")[0];
const BOARD = 1;
/** New CI runs stay pending this long, then go green (unless a PR is set to fail). */
const CI_SECONDS = Number(process.env.FAKE_GITHUB_CI_SECONDS ?? 8);
const COLUMNS = ["Backlog", "Ready", "In progress", "In review", "Done"];
const optionId = (name) => `opt-${name.toLowerCase().replace(/\s+/g, "-")}`;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (...words) => words.every((w) => args.includes(w));
const out = (value) => {
  if (value === undefined || value === null) return;
  process.stdout.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value)}\n`);
};
const fileText = (name) => {
  const file = flag(name);
  return file && existsSync(file) ? readFileSync(file, "utf8") : "";
};

const issueUrl = (n) => `https://github.com/${state.repo}/issues/${n}`;
const prUrl = (n) => `https://github.com/${state.repo}/pull/${n}`;
const runUrl = (pr, check) => `https://github.com/${state.repo}/actions/runs/${9000 + pr.number}/job/${check}`;
const issue = (n) => state.issues.find((i) => i.number === Number(n));
const pr = (n) => state.prs.find((p) => p.number === Number(n));
const nextNumber = () => state.next++;
const ticketOfBranch = (branch) => Number(/(?:^|\/)(\d+)-/.exec(branch)?.[1]) || null;

/** pass | fail | pending, from the PR's CI setting and how long ago its run started. */
const ciOf = (p) => {
  if (p.state === "MERGED" || p.ci === "pass") return "pass";
  if (p.ci === "fail") return "fail";
  return Date.now() - p.ciStartedAt < CI_SECONDS * 1000 ? "pending" : "pass";
};
const CHECKS = ["test", "lint", "e2e (playwright)"];
const checksOf = (p) => {
  const ci = ciOf(p);
  return CHECKS.map((name, i) => {
    // A red PR fails its e2e only; the rest passed.
    const bucket = ci === "fail" ? (i === 2 ? "fail" : "pass") : ci;
    return { name, workflow: "CI", bucket, link: runUrl(p, i + 1) };
  });
};

// ─── GraphQL: the one query `nf flow` sends ──────────────────────────────────

const issueNode = (i) => ({
  number: i.number,
  title: i.title,
  url: issueUrl(i.number),
  state: i.state,
  projectItems: { nodes: [{ project: { number: BOARD, owner: { login: OWNER } }, fieldValueByName: { name: i.status } }] },
});
const prNode = (p) => ({
  number: p.number,
  url: prUrl(p.number),
  state: p.state,
  commits: {
    nodes: [{
      commit: {
        statusCheckRollup: {
          contexts: {
            nodes: checksOf(p).map((c) => ({
              __typename: "CheckRun",
              status: c.bucket === "pending" ? "IN_PROGRESS" : "COMPLETED",
              conclusion: c.bucket === "pass" ? "SUCCESS" : c.bucket === "fail" ? "FAILURE" : null,
              detailsUrl: c.link,
            })),
          },
        },
      },
    }],
  },
});

const flowAnswer = (query) => {
  const repo = { open: { nodes: state.issues.filter((i) => i.state === "OPEN").sort((a, b) => b.updated - a.updated).map(issueNode) } };
  for (const [, alias, n] of query.matchAll(/(t\d+): issue\(number: (\d+)\)/g)) repo[alias] = issue(n) ? issueNode(issue(n)) : null;
  for (const [, alias, branch] of query.matchAll(/(p\d+): pullRequests\(headRefName: "([^"]+)"/g)) {
    const found = state.prs.filter((p) => p.branch === branch).sort((a, b) => b.number - a.number)[0];
    repo[alias] = { nodes: found ? [prNode(found)] : [] };
  }
  return repo;
};

// ─── Mutations shared by gh commands and the director ────────────────────────

const setStatus = (n, column) => {
  const i = issue(n);
  if (!i) return;
  i.status = column;
  i.updated = Date.now();
};
const mergePr = (p) => {
  p.state = "MERGED";
  const n = ticketOfBranch(p.branch);
  if (n && issue(n)) {
    issue(n).state = "CLOSED";
    setStatus(n, "Done");
  }
};

// ─── gh ──────────────────────────────────────────────────────────────────────

const gh = () => {
  const [a, b] = args;
  if (has("--version")) return out("gh version 2.96.0 (demo)");
  if (a === "auth") return out("Logged in to github.com (demo)");
  if (a === "repo" && b === "view") return out(state.repo);

  if (a === "issue") {
    if (b === "create") {
      const n = nextNumber();
      state.issues.push({ number: n, title: flag("--title"), body: fileText("--body-file"), state: "OPEN", status: "Backlog", updated: Date.now() });
      save();
      return out(issueUrl(n));
    }
    const i = issue(args[2]);
    if (!i) {
      process.stderr.write(`GraphQL: Could not resolve to an issue with the number of ${args[2]}.\n`);
      process.exitCode = 1;
      return;
    }
    if (b === "view") return out({ number: i.number, title: i.title, state: i.state, url: issueUrl(i.number) });
    if (b === "close") {
      i.state = "CLOSED";
      setStatus(i.number, "Done");
    }
    i.updated = Date.now();
    save();
    return;
  }

  if (a === "project") {
    if (b === "view") return out("PVT_demo");
    if (b === "field-list") return out({ fields: [{ id: "F_status", name: "Status", options: COLUMNS.map((name) => ({ id: optionId(name), name })) }] });
    if (b === "item-add") return out(`item-${/\/issues\/(\d+)/.exec(flag("--url") ?? "")?.[1]}`);
    if (b === "item-edit") {
      const n = /^item-(\d+)$/.exec(flag("--id") ?? "")?.[1];
      const column = COLUMNS.find((c) => optionId(c) === flag("--single-select-option-id"));
      if (n && column) setStatus(n, column);
      save();
      return;
    }
    if (b === "item-list") {
      const jq = flag("--jq") ?? "";
      const one = /select\(\.content\.number==(\d+)\)/.exec(jq);
      if (one) return out(issue(one[1]) ? `item-${one[1]}` : "");
      const columns = JSON.parse(/\.status as \$s \| (\[[^\]]*\])/.exec(jq)?.[1] ?? "[]");
      return out(state.issues.filter((i) => columns.includes(i.status)).map((i) => ({ number: i.number, title: i.title, status: i.status, url: issueUrl(i.number) })));
    }
  }

  if (a === "pr") {
    if (b === "list") {
      const want = flag("--state") ?? "open";
      const found = state.prs
        .filter((p) => p.branch === flag("--head") && (want === "all" || p.state === want.toUpperCase()))
        .sort((x, y) => y.number - x.number)[0];
      return out(found ? { number: found.number, url: prUrl(found.number), state: found.state } : "");
    }
    if (b === "create") {
      const n = nextNumber();
      state.prs.push({ number: n, branch: flag("--head"), title: flag("--title"), body: fileText("--body-file"), state: "OPEN", ci: "auto", ciStartedAt: Date.now() });
      save();
      return out(prUrl(n));
    }
    const p = pr(args[2]);
    if (!p) {
      process.stderr.write(`no pull requests found for ${args[2]}\n`);
      process.exitCode = 1;
      return;
    }
    if (b === "view") {
      const field = flag("--json");
      if (field === "statusCheckRollup") return out(String(CHECKS.length));
      return out({ headRefName: p.branch, body: p.body ?? "", title: p.title, state: p.state, url: prUrl(p.number) }[field] ?? "");
    }
    if (b === "edit") p.body = fileText("--body-file") || p.body;
    if (b === "merge") mergePr(p);
    if (b === "checks") {
      const checks = checksOf(p);
      out(checks);
      // Like real gh: 1 when a check failed, 8 while some are pending.
      process.exitCode = checks.some((c) => c.bucket === "fail") ? 1 : checks.some((c) => c.bucket === "pending") ? 8 : 0;
      return;
    }
    save();
    return;
  }

  if (a === "run") {
    const p = state.prs.find((x) => 9000 + x.number === Number(args[2]));
    if (b === "view") return out("e2e (playwright)\tRun tests\t  ✘ checkout.spec.ts:42 › pays with Apple Pay\n    Error: expect(locator).toBeVisible() failed\n    Locator: getByRole('button', { name: 'Apple Pay' })");
    if (b === "rerun" && p) {
      p.ci = "auto";
      p.ciStartedAt = Date.now();
      save();
    }
    return;
  }

  if (a === "api") {
    if (b === "graphql") {
      const query = args.find((x) => x.startsWith("query="))?.slice(6) ?? "";
      if (query.includes("open: issues")) return out(flowAnswer(query));
      return out([]); // review threads etc.: nothing to show
    }
    const endpoint = args.slice(1).find((x) => x.startsWith("repos/")) ?? "";
    if (endpoint.includes("/git/trees") || endpoint.includes("/git/commits")) return out("demo-sha");
    if (endpoint.includes("/contents/")) return out(has("PUT") ? decodeURIComponent(endpoint.split("/contents/")[1]) : "");
    if (endpoint.endsWith("/comments")) return out([]);
    if (/\/issues\/\d+$/.test(endpoint)) return out("1000");
    return out("");
  }
};

// ─── Director: move the story along from a second terminal ───────────────────

const DIRECTOR = `node demo/fake-github.mjs demo <command>
  ci <pr> pass|fail|auto   set a PR's CI (auto = pending for ${CI_SECONDS}s, then green)
  merge <pr>               merge it (its ticket closes and moves to Done)
  status <issue> <column>  move a ticket: ${COLUMNS.join(" | ")}
  ticket "<title>"         add a Ready ticket
  show                     print the state`;

const director = () => {
  const [, cmd, x, ...rest] = args;
  if (cmd === "ci" && pr(x)) {
    pr(x).ci = rest[0] ?? "auto";
    pr(x).ciStartedAt = Date.now();
  } else if (cmd === "merge" && pr(x)) mergePr(pr(x));
  else if (cmd === "status" && issue(x)) setStatus(x, rest.join(" "));
  else if (cmd === "ticket" && x) state.issues.push({ number: nextNumber(), title: x, state: "OPEN", status: "Ready", updated: Date.now() });
  else if (cmd === "show") return out(state);
  else {
    process.stderr.write(`${DIRECTOR}\n`);
    process.exitCode = 1;
    return;
  }
  save();
  out(`ok: ${args.slice(1).join(" ")}`);
};

if (args[0] === "demo") director();
else gh();
