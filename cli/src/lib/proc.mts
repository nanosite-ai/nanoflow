// Subprocesses that behave the same on Windows, macOS and Linux. Windows reaches npm/npx/pnpm/yarn
// through .cmd shims, which only a shell can run, so those calls go through cmd.exe as ONE quoted string.
import { execFile, execFileSync, spawnSync, type SpawnSyncOptions } from "node:child_process";

export const IS_WIN = process.platform === "win32";

export class CommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

const SHIMS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "bunx"]);
const needsShell = (cmd: string): boolean => IS_WIN && SHIMS.has(cmd);

/** cmd.exe quoting, so a shell call is one command string (args + shell:true is deprecated, DEP0190). */
export const quoteForCmd = (arg: string): string => (/^[\w./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

/**
 * NANOFLOW_GH=<script.mjs> stands in for gh, NANOFLOW_ACLI for acli (run with node): the e2e tests' fakes, or
 * a wrapper of your own.
 */
const override = (cmd: string): string | undefined =>
  (cmd === "gh" ? process.env.NANOFLOW_GH : cmd === "acli" ? process.env.NANOFLOW_ACLI : undefined) || undefined;

const prepare = (cmd: string, args: string[]): [string, string[]] => {
  const fake = override(cmd);
  if (fake) return [process.execPath, [fake, ...args]];
  return needsShell(cmd) ? [[cmd, ...args].map(quoteForCmd).join(" "), []] : [cmd, args];
};

const MAX_BUFFER = 64 * 1024 * 1024;

/** Run a command and return trimmed stdout. Throws CommandError with stderr on failure. */
export const run = (cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): string => {
  try {
    const [file, argv] = prepare(cmd, args);
    return execFileSync(file, argv, {
      cwd: opts.cwd,
      input: opts.input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      shell: needsShell(cmd),
      maxBuffer: MAX_BUFFER,
    }).trim();
  } catch (err) {
    const e = err as { status?: number; stderr?: string; stdout?: string; message: string };
    const detail = (e.stderr || e.stdout || e.message).toString().trim();
    throw new CommandError(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${detail}`, e.status ?? 1);
  }
};

/** Like run, but null instead of throwing. */
export const tryRun = (cmd: string, args: string[], opts: { cwd?: string } = {}): string | null => {
  try {
    return run(cmd, args, opts);
  } catch {
    return null;
  }
};

/** Async tryRun, for fanning independent calls out in parallel. */
export const tryRunAsync = (cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string | null> =>
  new Promise((resolve) => {
    const [file, argv] = prepare(cmd, args);
    execFile(file, argv, { cwd: opts.cwd, encoding: "utf8", shell: needsShell(cmd), maxBuffer: MAX_BUFFER }, (err, stdout) =>
      resolve(err ? null : stdout.trim()),
    );
  });

/** Run a command without blocking: its exit code, stdout and stderr, never a throw (a missing binary is code 127). */
export const runAsync = (cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const [file, argv] = prepare(cmd, args);
    execFile(file, argv, { cwd: opts.cwd, encoding: "utf8", shell: needsShell(cmd), maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      const exit = (err as { code?: unknown } | null)?.code;
      const code = !err ? 0 : typeof exit === "number" ? exit : 127;
      resolve({ code, stdout: stdout.trim(), stderr: (stderr || (err && !stdout ? err.message : "")).trim() });
    });
  });

/** Run a command and keep its stdout whatever the exit code (gh signals failing checks with one). Never throws. */
export const runAnyExit = (cmd: string, args: string[], opts: { cwd?: string } = {}): { code: number; stdout: string } => {
  const [file, argv] = prepare(cmd, args);
  const res = spawnSync(file, argv, { cwd: opts.cwd, encoding: "utf8", shell: needsShell(cmd), maxBuffer: MAX_BUFFER });
  return { code: res.status ?? 1, stdout: (res.stdout ?? "").trim() };
};

export interface Captured {
  code: number;
  output: string;
  ms: number;
}

/**
 * Run a shell command line (from nanoflow.json: checks, stack.before) to completion, capturing its output
 * for a condensed summary. Never throws.
 */
export const runShellCapture = (commandLine: string, opts: { cwd?: string; env?: Record<string, string> } = {}): Captured => {
  const started = Date.now();
  const res = spawnSync(commandLine, {
    cwd: opts.cwd,
    encoding: "utf8",
    shell: true,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, FORCE_COLOR: "0", ...opts.env },
  });
  return { code: res.status ?? 1, output: `${res.stdout ?? ""}${res.stderr ?? ""}`, ms: Date.now() - started };
};

/** Last n non-empty lines of some output. */
export const tail = (text: string, n: number): string =>
  text.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");

/** Run with inherited stdio (streams to the user). Returns the exit code. */
export const runInherit = (cmd: string, args: string[], opts: SpawnSyncOptions = {}): number => {
  const [file, argv] = prepare(cmd, args);
  return spawnSync(file, argv, { stdio: "inherit", shell: needsShell(cmd), ...opts }).status ?? 1;
};
