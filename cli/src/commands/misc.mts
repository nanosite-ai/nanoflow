// check, flow, summary: the read-mostly commands that keep an agent's context small.
import path from "node:path";
import type { Command } from "commander";
import { collectFlow, type FlowSnapshot } from "../lib/flow.mjs";
import { prForBranch, PR_STATE } from "../lib/gh.mjs";
import { c, info, result, warn } from "../lib/output.mjs";
import { runShellCapture, tail } from "../lib/proc.mjs";
import { isMainCheckout, requireRepo } from "../lib/repo.mjs";
import { portOf, slotOf, ticketOf } from "../lib/worktree.mjs";
import { issueUrl } from "../lib/gh.mjs";

export const registerCheck = (program: Command): void => {
  program
    .command("check")
    .description("run the repo's checks (checks in nanoflow.json); prints one line each, and only the tail of a failure")
    .argument("[names...]", "which checks (default: all)")
    .option("--lines <n>", "output lines shown per failing check", "40")
    .addHelpText("after", "\nExamples:\n  nf check\n  nf check typecheck lint\n  nf check test --json")
    .action((names: string[], opts: { lines: string }) => {
      const repo = requireRepo();
      const all = Object.entries(repo.config.checks);
      if (!all.length) throw new Error('No checks configured. Add "checks": { "typecheck": "npm run typecheck", "test": "npm test" } to .claude/nanoflow.json.');
      const unknown = names.filter((n) => !repo.config.checks[n]);
      if (unknown.length) throw new Error(`Unknown check(s): ${unknown.join(", ")}. Configured: ${all.map(([n]) => n).join(", ")}.`);
      const picked = names.length ? all.filter(([n]) => names.includes(n)) : all;
      const results = picked.map(([name, command]) => {
        const res = runShellCapture(command, { cwd: repo.checkoutRoot });
        const ok = res.code === 0;
        info(`${ok ? c.ok("✔") : c.err("✖")} ${name} ${c.dim(`(${(res.ms / 1000).toFixed(1)}s)`)}`);
        const output = ok ? "" : tail(res.output, Number(opts.lines));
        if (!ok) info(c.dim(output));
        return { name, command, ok, ms: res.ms, output };
      });
      const failed = results.filter((r) => !r.ok);
      result({ ok: !failed.length, results }, () => info(failed.length ? c.err(`${failed.length} of ${results.length} failed`) : c.ok(`all ${results.length} green`)));
      if (failed.length) process.exitCode = 1;
    });
};

const renderFlow = (snap: FlowSnapshot): void => {
  for (const wt of snap.worktrees) {
    const mark = wt.isCurrent ? c.magenta("▶") : " ";
    const ticket = wt.ticket ? `#${wt.ticket.number}${wt.ticket.title ? ` ${wt.ticket.title}` : ""}` : "";
    info(`${mark} ${c.bold(wt.name)}  ${c.cyan(wt.branch ?? "(detached)")}  ${ticket}${wt.ticket?.status ? c.dim(` [${wt.ticket.status}]`) : ""}`);
    const bits = [
      wt.slot !== null ? `slot ${wt.slot}` : "",
      wt.dirty ? c.warn(`${wt.dirty} changed`) : "",
      wt.ahead ? `${wt.ahead} ahead` : "",
      wt.pr ? `PR #${wt.pr.number} ${wt.pr.state.toLowerCase()}${wt.pr.ci !== "none" ? ` · CI ${wt.pr.ci}` : ""}` : "",
      ...wt.services.map((s) => (s.isUp ? c.ok(`● ${s.name} :${s.port}`) : c.dim(`○ ${s.name} :${s.port}`))),
    ].filter(Boolean);
    info(`    ${bits.join("  ")}`);
  }
  if (snap.board) {
    info(c.bold("\nTickets"));
    for (const t of snap.board) info(`  #${t.number} ${t.title ?? ""}${t.status ? c.dim(` [${t.status}]`) : ""}${t.worktree ? c.cyan(` → ${t.worktree}`) : ""}`);
  }
};

export const registerFlow = (program: Command): void => {
  program
    .command("flow")
    .description("one snapshot of every worktree (slot, services up, ticket, PR, CI) and the open tickets; the nanoflow mod's provider")
    .option("--local", "skip GitHub (fast: git + ports only)")
    .addHelpText("after", "\nExamples:\n  nf flow\n  nf flow --json\n  nf flow --json --local")
    .action(async (opts: { local?: boolean }) => {
      const repo = requireRepo();
      const snap = await collectFlow(repo, { cwd: process.cwd(), local: Boolean(opts.local) });
      result(snap, () => renderFlow(snap));
    });
};

export const registerSummary = (program: Command): void => {
  program
    .command("summary")
    .description("the wrap-up footer for the current task, from live state: worktree, branch, PR, ticket, done, local URL")
    .option("--what <text>", "one line: what we did, product-level")
    .option("--next <items...>", "next steps (one or more)")
    .option("--shipped <text>", "only when something was released / deployed")
    .addHelpText("after", '\nExamples:\n  nf summary --what "csv export for orders" --next "review + merge"\n  nf summary --next "tear down" "watch errors" --json')
    .action((opts: { what?: string; next?: string[]; shipped?: string }) => {
      const repo = requireRepo();
      const main = isMainCheckout(repo);
      const ticket = ticketOf(repo.config, repo.branch);
      const pr = (() => {
        if (main) return null;
        try {
          return prForBranch(repo, repo.branch, PR_STATE.all);
        } catch {
          warn("could not read the PR from GitHub; the footer shows local state only");
          return null;
        }
      })();
      const merged = pr?.state === "MERGED";
      const slot = slotOf(repo.config, repo.checkoutRoot);
      const open = repo.config.services.find((s) => s.open) ?? repo.config.services.find((s) => typeof s.base === "number");
      const port = open ? portOf(open, slot) : null;
      const local = !main && !merged && port !== null ? `http://${repo.config.host}:${port}` : null;
      const link = (label: string, url: string | null | undefined): string => (url ? `[${label}](${url})` : label);
      const fields = {
        worktree: main ? "none" : path.basename(repo.checkoutRoot),
        branch: merged ? `merged→${repo.config.mainBranch}` : repo.branch,
        pr: pr ? link(`#${pr.number}`, pr.url) : "—",
        ticket: ticket ? link(`#${ticket}`, issueUrl(repo, ticket)) : "—",
        done: merged ? "yes" : "no",
      };
      const lines = [
        `**[worktree: ${fields.worktree}] [branch: ${fields.branch}] [PR: ${fields.pr}] [ticket: ${fields.ticket}] [done: ${fields.done}]**`,
        ...(local ? [`**Local:** ${local}`] : []),
        ...(opts.what ? [`**What we did:** ${opts.what}`] : []),
        ...(opts.shipped ? [`**Shipped:** ${opts.shipped}`] : []),
      ];
      // Once merged, tearing the worktree down is always the first next step (and it needs a yes).
      const next = [...(merged && !main ? [`Tear down \`${path.basename(repo.checkoutRoot)}\`? (deletes the dir + local branch)`] : []), ...(opts.next ?? [])];
      if (next.length === 1) lines.push(`**Next:** ${next[0]}`);
      else if (next.length > 1) lines.push(`**Next:**\n${next.map((n) => `* ${n}`).join("\n")}`);
      if (!opts.what) warn("pass --what for the one-line gist");
      result({ ...fields, local, what: opts.what ?? null, next, text: lines.join("\n") }, () => console.log(lines.join("\n")));
    });
};
