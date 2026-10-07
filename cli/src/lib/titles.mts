// Session + terminal title that follows the task: `#<ticket> · <branch> · <short> [· PR #<n>] [✓]`.
// The Claude Code session is renamed the way `/rename` does it: a custom-title record appended to the
// session's transcript. The terminal tab is set with an escape sequence, or on Windows by attaching to the
// console of the Claude process.
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fillTemplate, type FlowConfig } from "./config.mjs";
import { tempFile } from "./globals.mjs";
import { c, info, step } from "./output.mjs";
import { IS_WIN, tryRun } from "./proc.mjs";

export const SEP = " · ";

export const baseTitle = (config: FlowConfig, ticket: number | string, branch: string, short: string): string =>
  fillTemplate(config.title.format, { ticket, branch, short });

export const withPr = (base: string, pr: number | string, merged = false): string => `${base}${SEP}PR #${pr}${merged ? " ✓" : ""}`;

/** Append a custom-title record to the calling session's transcript. False when there is no session. */
export const renameSession = (title: string, sessionId = process.env.CLAUDE_CODE_SESSION_ID): boolean => {
  if (!sessionId) return false;
  const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "projects");
  if (!existsSync(root)) return false;
  // Search every project dir: the session may have started in another checkout than the cwd.
  const transcript = readdirSync(root).map((d) => path.join(root, d, `${sessionId}.jsonl`)).find((f) => existsSync(f));
  if (!transcript) return false;
  appendFileSync(transcript, `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId })}\n`);
  return true;
};

// Tool commands run detached from the console that hosts Claude Code, so attach to that process's console.
const WIN_TITLE_PS1 = `param([string]$Title, [int]$TargetPid)
Add-Type -Namespace Win32 -Name Console -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool SetConsoleTitle(string title);
'@
[void][Win32.Console]::FreeConsole()
if (-not [Win32.Console]::AttachConsole([uint32]$TargetPid)) { exit 1 }
if (-not [Win32.Console]::SetConsoleTitle($Title)) { exit 1 }
[void][Win32.Console]::FreeConsole()
`;

export const setTerminalTitle = (title: string): boolean => {
  if (IS_WIN) {
    const pid = process.env.CLAUDE_PID;
    if (!pid) return false;
    const script = tempFile("title.ps1", WIN_TITLE_PS1);
    return tryRun("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Title", title, "-TargetPid", pid]) !== null;
  }
  process.stderr.write(`\u001b]0;${title}\u0007`);
  return true;
};

export const applyTitles = (config: FlowConfig, title: string): void => {
  step(title);
  if (!config.title.enabled) return;
  const session = renameSession(title);
  setTerminalTitle(title);
  if (!session && process.env.CLAUDECODE) info(c.dim("(session not renamed: no CLAUDE_CODE_SESSION_ID)"));
};
