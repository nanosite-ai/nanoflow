import { CommanderError } from "commander";
import { c, setJsonMode } from "./lib/output.mjs";
import { setAssumeYes } from "./lib/prompt.mjs";
import { buildProgram } from "./registry.mjs";

export const main = async (argv: string[]): Promise<void> => {
  const program = buildProgram();
  program.exitOverride();
  program.hook("preAction", (_root, action) => {
    const opts = action.optsWithGlobals<{ json?: boolean; yes?: boolean }>();
    setJsonMode(Boolean(opts.json));
    setAssumeYes(Boolean(opts.yes));
  });
  try {
    await program.parseAsync(argv);
  } catch (err) {
    // exitCode, not process.exit(): exiting while fetch() sockets close aborts Node on Windows.
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode;
      return;
    }
    process.stderr.write(`${c.err("✖")} ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = (err as { exitCode?: number }).exitCode ?? 1;
  }
};
