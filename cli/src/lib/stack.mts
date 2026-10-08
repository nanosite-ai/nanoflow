// The local dev stack of one checkout: which services start, on which slot env, where --bg logs go, and
// how to tell it answers.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FlowConfig, ServiceSpec } from "./config.mjs";
import { killTree, waitForExit } from "./kill.mjs";
import { IS_WIN } from "./proc.mjs";
import { portOf } from "./worktree.mjs";

/** The services `up` starts: those with a start command, minus optional ones not named in `with`. */
export const servicesToStart = (config: FlowConfig, withNames: string[] = []): ServiceSpec[] =>
  config.services.filter((s) => s.start && (!s.optional || withNames.includes(s.name)));

export const stateDir = (config: FlowConfig, checkoutRoot: string): string => path.join(checkoutRoot, config.stack.stateDir);
export const logFile = (config: FlowConfig, checkoutRoot: string, name: string): string => path.join(stateDir(config, checkoutRoot), "logs", `${name}.log`);
const stateFile = (config: FlowConfig, checkoutRoot: string): string => path.join(stateDir(config, checkoutRoot), "stack.json");

export interface StackState {
  /** The --bg supervisor. */
  pid: number;
  /** The services it started, so a stop reaches them even if the supervisor can't relay it. */
  children?: number[];
  apps: string[];
  startedAt: string;
}

export const readStackState = (config: FlowConfig, checkoutRoot: string): StackState | null => {
  try {
    return JSON.parse(readFileSync(stateFile(config, checkoutRoot), "utf8")) as StackState;
  } catch {
    return null;
  }
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const stopRecordedStack = (config: FlowConfig, checkoutRoot: string): number[] => {
  const state = readStackState(config, checkoutRoot);
  rmSync(stateFile(config, checkoutRoot), { force: true });
  if (!state) return [];
  const pids = [state.pid, ...(state.children ?? [])].filter(isAlive);
  const killed = killTree(pids);
  waitForExit(pids);
  return killed;
};

/** Any HTTP answer (even 401/404) means the service is listening. */
export const isUp = async (url: URL, timeoutMs = 2000): Promise<boolean> => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
};

export const healthUrl = (config: FlowConfig, s: ServiceSpec, slot: number): URL | null => {
  const port = portOf(s, slot);
  if (port === null) return null;
  const url = new URL("http://localhost");
  url.hostname = config.host;
  url.port = String(port);
  url.pathname = s.path ?? "/";
  return url;
};

/** Poll until each ready service answers, or give up. */
export const waitUntilUp = async (urls: URL[], timeoutMs: number, onWait?: (down: URL[]) => void): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const checks = await Promise.all(urls.map(async (u) => ({ u, up: await isUp(u) })));
    const down = checks.filter((x) => !x.up).map((x) => x.u);
    if (!down.length) return true;
    if (Date.now() > deadline) return false;
    onWait?.(down);
    await sleep(2000);
  }
};

const COLORS = [36, 32, 35, 33, 34, 31];

/**
 * Run the services until one exits or we're signalled, then stop all of them. With logToFiles each writes
 * to <stateDir>/logs/<name>.log (the --bg supervisor); otherwise output is line-prefixed to the terminal.
 */
export const superviseStack = (args: { config: FlowConfig; checkoutRoot: string; services: ServiceSpec[]; env: Record<string, string>; logToFiles: boolean }): void => {
  const { config, checkoutRoot } = args;
  const children: ChildProcess[] = [];
  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    killTree(children.flatMap((ch) => (ch.pid ? [ch.pid] : [])));
    if (args.logToFiles) rmSync(stateFile(config, checkoutRoot), { force: true });
    setTimeout(() => process.exit(code), 300);
  };

  const recordState = (): void => {
    if (!args.logToFiles) return;
    const state: StackState = {
      pid: process.pid,
      children: children.flatMap((ch) => (ch.pid ? [ch.pid] : [])),
      apps: args.services.map((s) => s.name),
      startedAt: new Date().toISOString(),
    };
    writeFileSync(stateFile(config, checkoutRoot), JSON.stringify(state));
  };
  if (args.logToFiles) mkdirSync(path.join(stateDir(config, checkoutRoot), "logs"), { recursive: true });

  args.services.forEach((svc, i) => {
    const start = svc.start!;
    // Unix: each service leads its own process group, so stopping it also stops what its shell started.
    const child = spawn(start.run, { cwd: path.join(checkoutRoot, start.cwd ?? "."), env: { ...process.env, ...args.env }, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: !IS_WIN });
    children.push(child);
    if (args.logToFiles) {
      const out = createWriteStream(logFile(config, checkoutRoot, svc.name), { flags: "w" });
      child.stdout?.pipe(out);
      child.stderr?.pipe(out);
    } else {
      const prefix = `\u001b[${COLORS[i % COLORS.length]}m[${svc.name}]\u001b[0m `;
      for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
        let buf = "";
        stream?.on("data", (d: Buffer) => {
          buf += d.toString();
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) sink.write(`${prefix}${line}\n`);
        });
      }
    }
    child.on("exit", (code) => {
      if (!args.logToFiles) process.stdout.write(`[${svc.name}] exited (code ${code})\n`);
      shutdown(code ?? 0); // one process dies → the whole stack goes down
    });
  });

  recordState();
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
};

export const hasLogs = (config: FlowConfig, checkoutRoot: string, name: string): boolean => existsSync(logFile(config, checkoutRoot, name));
