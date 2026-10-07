// Every command registers itself here. The commander tree is the single source for --help and docs/cli.md.
import { Command } from "commander";
import { registerCheck, registerFlow, registerSummary } from "./commands/misc.mjs";
import { registerCi, registerPr, registerShots } from "./commands/pr.mjs";
import { registerDocs, registerSetup } from "./commands/setup.mjs";
import { registerStack } from "./commands/stack.mjs";
import { registerTask, registerTitle } from "./commands/task.mjs";
import { registerBoard, registerTicket } from "./commands/ticket.mjs";
import { registerEnv, registerWt } from "./commands/wt.mjs";

export const VERSION = "0.1.0";

export const buildProgram = (): Command => {
  const program = new Command("nanoflow")
    .description("nanoflow by nanosite.ai: one command per dev ritual (ticket → worktree on its own ports → checks → PR → CI → teardown). Built for coding agents. Alias: nf.\nhttps://github.com/nanosite-ai/nanoflow")
    .version(VERSION)
    .option("--json", "machine-readable output on stdout (progress goes to stderr)")
    .option("-y, --yes", "answer yes to confirmations (required when there is no TTY)")
    .option("--dry", "print what would happen; change nothing")
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: true });

  registerTask(program);
  registerTicket(program);
  registerBoard(program);
  registerTitle(program);
  registerWt(program);
  registerEnv(program);
  registerStack(program);
  registerCheck(program);
  registerPr(program);
  registerShots(program);
  registerCi(program);
  registerFlow(program);
  registerSummary(program);
  registerSetup(program);
  registerDocs(program);
  return program;
};
