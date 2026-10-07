// Stop the processes that hold a worktree's files (dev servers keep them open on Windows, so the worktree
// can't be deleted) or listen on a port.
import path from "node:path";
import { IS_WIN, tryRun } from "./proc.mjs";

/** Dev-server runtimes whose command line places them inside a worktree. */
const RUNTIMES = ["node", "esbuild", "bun", "deno", "python", "python3", "ruby", "java", "go", "dotnet"];

const ps = (script: string): string => tryRun("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]) ?? "";

const pids = (out: string): number[] =>
  [...new Set(out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid))];

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Runtime processes whose command line runs from inside `dir` (dir + separator, so siblings don't match). */
export const processesInDir = (dir: string): number[] => {
  const abs = path.resolve(dir);
  if (IS_WIN) {
    const names = RUNTIMES.map((n) => psQuote(`${n}.exe`)).join(",");
    const back = psQuote(`*${abs}\\*`);
    const fwd = psQuote(`*${abs.replace(/\\/g, "/")}/*`);
    return pids(ps(`Get-CimInstance Win32_Process | Where-Object { ($_.Name -in ${names}) -and ($_.CommandLine -like ${back} -or $_.CommandLine -like ${fwd}) } | ForEach-Object { $_.ProcessId }`));
  }
  return pids(tryRun("pgrep", ["-f", `${abs}/`]) ?? "");
};

/** Processes listening on a TCP port. */
export const processesOnPort = (port: number): number[] =>
  IS_WIN
    ? pids(ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`))
    : pids(tryRun("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]) ?? "");

/** Kill each pid and its children. Returns the pids that were signalled. */
export const killTree = (targets: number[]): number[] =>
  targets.filter((pid) =>
    IS_WIN ? tryRun("taskkill", ["/PID", String(pid), "/T", "/F"]) !== null : tryRun("kill", ["-TERM", String(pid)]) !== null,
  );
