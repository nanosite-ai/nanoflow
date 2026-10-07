import path from "node:path";
import type { Command } from "commander";
import { prForBranch, PR_STATE } from "../lib/gh.mjs";
import { dryRun, withEnvOptions } from "../lib/globals.mjs";
import { c, info, result, success, warn } from "../lib/output.mjs";
import { confirm } from "../lib/prompt.mjs";
import { findRepo, requireRepo, type RepoContext } from "../lib/repo.mjs";
import {
  assertFeature,
  branchFor,
  createWorktree,
  findWorktree,
  listWorktrees,
  nameVars,
  portOf,
  printTeardownChecklist,
  readMeta,
  removeWorktree,
  servicesLine,
  slotOf,
  slotVars,
  envForSlot,
  worktreeDirFor,
} from "../lib/worktree.mjs";

export const registerWt = (program: Command): void => {
  const wt = program.command("wt").description("git worktrees: one per task, each on its own port slot");

  wt.command("create")
    .description("add a worktree + branch for <ticket>-<slug> on the next free port slot; copy and patch shared files; install")
    .argument("<name>", "<ticket>-<slug>, e.g. 563-worktree-teardown")
    .option("--slot <n>", "explicit slot (default: next free)")
    .option("--no-install", "skip the install step")
    .addHelpText("after", "\nExamples:\n  nf wt create 563-worktree-teardown\n  nf wt create 563-x --slot 4 --no-install")
    .action((name: string, opts: { slot?: string; install?: boolean }, cmd: Command) => {
      const repo = requireRepo();
      const feature = assertFeature(name);
      if (dryRun(cmd, `would create ${worktreeDirFor(repo, feature)} on ${branchFor(repo, feature)}`)) return;
      const dir = createWorktree(repo, feature, { slot: opts.slot ? Number(opts.slot) : undefined, install: opts.install });
      result({ dir }, () => info(`next: cd "${dir}" && nf up --bg`));
    });

  wt.command("list")
    .description("worktrees with their slot, branch and ports")
    .addHelpText("after", "\nExamples:\n  nf wt list\n  nf wt list --json")
    .action(() => {
      const repo = requireRepo();
      const trees = listWorktrees(repo.config, repo.mainRoot);
      result(
        trees.map((t) => ({ ...t, slot: slotOf(repo.config, t.path) })),
        () => {
          for (const t of trees) info(`${c.bold(path.basename(t.path))}  [${t.branch ?? t.head}]  ${c.dim(t.path)}\n  ${servicesLine(repo.config, slotOf(repo.config, t.path))}`);
        },
      );
    });

  wt.command("remove")
    .description("stop the worktree's processes, delete it, prune (refuses uncommitted/unpushed work unless --force); prints the agent cleanup checklist")
    .argument("<name>", "worktree name, e.g. 563-worktree-teardown")
    .option("--delete-branch", "also delete the local branch")
    .option("--force", "discard uncommitted / unpushed work")
    .addHelpText("after", "\nExamples:\n  nf wt remove 563-worktree-teardown --delete-branch")
    .action((name: string, opts: { deleteBranch?: boolean; force?: boolean }, cmd: Command) => {
      const repo = requireRepo();
      const found = findWorktree(repo, listWorktrees(repo.config, repo.mainRoot), name);
      const dir = found?.path ?? worktreeDirFor(repo, assertFeature(name));
      if (path.resolve(dir) === path.resolve(repo.mainRoot)) throw new Error("That is the main checkout.");
      const branch = found?.branch ?? branchFor(repo, name);
      if (dryRun(cmd, `would stop processes in ${dir}, delete it${opts.deleteBranch ? ` and branch ${branch}` : ""}`)) return;
      removeWorktree(repo, { dir, branch }, opts);
      printTeardownChecklist(repo.config);
    });

  wt.command("clean")
    .description("remove every worktree whose PR is merged or closed (asks first; --yes to confirm non-interactively)")
    .addHelpText("after", "\nExamples:\n  nf wt clean --dry\n  nf wt clean --yes")
    .action(async (_opts, cmd: Command) => {
      const repo = requireRepo();
      const candidates = listWorktrees(repo.config, repo.mainRoot)
        .filter((t) => path.resolve(t.path) !== path.resolve(repo.mainRoot) && t.branch)
        .map((t) => ({ t, pr: prForBranch(repo, t.branch as string, PR_STATE.all) }))
        .filter(({ pr }) => pr && pr.state !== "OPEN");
      if (!candidates.length) {
        result([], () => info("No worktrees with a merged/closed PR."));
        return;
      }
      info(c.bold("Worktrees with a merged/closed PR:"));
      for (const { t, pr } of candidates) info(`  ${path.basename(t.path)}  [${t.branch}]  PR #${pr?.number} ${pr?.state}`);
      if (dryRun(cmd, `would remove ${candidates.length} worktree(s) + their local branches`)) return;
      if (!(await confirm(`Remove these ${candidates.length} worktree(s) and their local branches?`))) return;
      // Squash-merged commits sit on no remote (main has the squash), so only that check is relaxed.
      const removed = candidates.filter(({ t }) => {
        try {
          removeWorktree(repo, { dir: t.path, branch: t.branch as string }, { deleteBranch: true, allowUnpushed: true });
          return true;
        } catch (err) {
          warn(`kept ${path.basename(t.path)}: ${(err as Error).message.split("\n")[0]}`);
          return false;
        }
      });
      result(removed.map(({ t, pr }) => ({ path: t.path, branch: t.branch, pr: pr?.number })), () => success(`removed ${removed.length} of ${candidates.length} worktree(s)`));
      if (removed.length) printTeardownChecklist(repo.config);
    });
};

/** Resolve --slot / --wt (default: this checkout's slot). */
export const resolveSlot = (repo: RepoContext, opts: { slot?: string; wt?: string }): { slot: number; dir: string | null } => {
  if (opts.slot !== undefined) {
    const slot = Number(opts.slot);
    if (!Number.isInteger(slot)) throw new Error(`Invalid slot "${opts.slot}".`);
    return { slot, dir: null };
  }
  if (opts.wt) {
    const found = findWorktree(repo, listWorktrees(repo.config, repo.mainRoot), opts.wt);
    if (!found) throw new Error(`No worktree named "${opts.wt}" (see \`nf wt list\`).`);
    return { slot: slotOf(repo.config, found.path), dir: found.path };
  }
  return { slot: slotOf(repo.config, repo.checkoutRoot), dir: repo.checkoutRoot };
};

export const registerEnv = (program: Command): void => {
  withEnvOptions(program.command("env").description("this checkout's slot: each service's port and URL, and the env `up` exports"))
    .addHelpText("after", "\nExamples:\n  nf env\n  nf env --wt 651-csv-export --json\n  nf env --slot 0")
    .action((opts: { slot?: string; wt?: string }) => {
      const repo = findRepo() ?? requireRepo();
      const { slot, dir } = resolveSlot(repo, opts);
      const feature = (dir ? readMeta(repo.config, dir)?.feature : null) ?? (slot === repo.config.slot.mainSlot ? "main" : `slot-${slot}`);
      const vars = slotVars(repo.config, slot, nameVars(repo, feature));
      const services = repo.config.services.flatMap((s) => {
        const port = portOf(s, slot);
        return port === null ? [] : [{ name: s.name, port, url: vars[`origin:${s.name}`] as string }];
      });
      const env = envForSlot(repo.config, slot, vars);
      result({ slot, services, env }, () => {
        info(c.bold(`slot ${slot}`));
        for (const s of services) info(`  ${s.name.padEnd(12)} ${s.url}`);
        for (const [k, v] of Object.entries(env)) info(c.dim(`  ${k}=${v}`));
      });
    });
};
