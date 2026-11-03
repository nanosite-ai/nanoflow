// Desktop notifications: which moments reach the OS (Windows toast, macOS Notification Center) and the
// argv that raises one. Pure: register.tsx runs the argv.

/** What a notification is about: its title, and whether `important` sends it. */
export type NfCategory = 'attention' | 'ci' | 'pr' | 'worktree' | 'failure' | 'turn' | 'service' | 'ticket' | 'activity'

/** all: every category · important: the ones marked so, and anything that failed · off: none. Toasts too. */
export type NfNotifyLevel = 'all' | 'important' | 'off'

export const NOTIFY_CATEGORY: Record<NfCategory, { title: string; important: boolean }> = {
  attention: { title: 'Claude needs you', important: true },
  ci: { title: 'CI', important: true },
  pr: { title: 'Pull request', important: true },
  worktree: { title: 'Worktree', important: true },
  failure: { title: 'Failed', important: true },
  turn: { title: 'Claude finished', important: false },
  service: { title: 'Service', important: false },
  ticket: { title: 'Ticket', important: false },
  activity: { title: 'Activity', important: false },
}

export const notifyLevelOf = (value: unknown): NfNotifyLevel =>
  value === 'important' || value === 'off' ? value : 'all'

type Categorized = { category?: NfCategory; tone: string; important: boolean }

/** The event's own category; an uncategorized error is a failure, anything else uncategorized is activity. */
export const categoryOf = (event: Categorized): NfCategory =>
  event.category ?? (event.tone === 'error' ? 'failure' : 'activity')

/**
 * Whether the event's own `important` flag counts on the desktop: only for an uncategorized one (a repo rule
 * marked important). A categorized event is as important as its category, so a pane action you just clicked
 * (activity) stays off the desktop at `important` while its toast still shows.
 */
export const desktopImportant = (event: Categorized): boolean => !event.category && event.important

/** `important` is the event's own flag, as for toasts: a repo rule marked important reaches `important` too. */
export const shouldNotify = (level: NfNotifyLevel, category: NfCategory, important = false): boolean =>
  level === 'all' || (level === 'important' && (important || NOTIFY_CATEGORY[category].important))

export const notifyTitle = (category: NfCategory): string => `nanoflow · ${NOTIFY_CATEGORY[category].title}`

/**
 * Claude Code's `Notification` types that mean the person is wanted: a permission, an answer, the prompt
 * idle. Others (`auth_success`, …) are not a reason to look up.
 */
export const ATTENTION_TYPES: ReadonlySet<string> = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog'])

/** An idle prompt this soon after "Claude finished" was already said. */
export const IDLE_AFTER_TURN_MS = 10 * 60_000

/** Each key sent and when; `claim` says whether `key` is new within `windowMs`, and the pruned map to keep. */
export const claim = (
  recent: Readonly<Record<string, number>>, key: string, now: number, windowMs: number,
): { isNew: boolean; recent: Record<string, number> } => {
  const kept = Object.fromEntries(Object.entries(recent).filter(([, at]) => now - at < windowMs))
  if (key in kept) return { isNew: false, recent: kept }
  return { isNew: true, recent: { ...kept, [key]: now } }
}

export type NfOs = 'win' | 'mac' | 'linux'

/** A script of the plugin's under Windows PowerShell, never prompting. */
export const powershellFile = (pluginRoot: string, script: string, args: readonly string[]): string[] =>
  ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${pluginRoot}/hooks/${script}`, ...args]

/**
 * The terminal a session draws in, read from what the terminal puts in its environment when it starts the
 * shell: what a click goes back to.
 * - `app`: the macOS app (`__CFBundleIdentifier`: com.apple.Terminal, com.googlecode.iterm2, …), brought forward.
 * - `iterm`: the iTerm2 session's unique id (from `ITERM_SESSION_ID`, `w0t1p0:<id>`), selected directly.
 * - `tty`: the session's terminal device on macOS (`/dev/ttys004`), how Terminal.app finds its tab.
 * - `wt`: the Windows Terminal tab's `WT_SESSION`. Kept for the record: Windows Terminal cannot be told to
 *   focus a tab by it, so a click finds the tab through the process (`pid`).
 */
export type NfTerminal = { app?: string; iterm?: string; tty?: string; wt?: string }

/** An app's bundle id, safe to put in an AppleScript string. */
export const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/

/** What the environment says about the terminal; anything malformed is left out. */
export const terminalFrom = (env: { bundle?: string | null; iterm?: string | null; wt?: string | null }): NfTerminal => {
  const iterm = env.iterm?.split(':').pop()
  return {
    ...(env.bundle && BUNDLE_ID.test(env.bundle) ? { app: env.bundle } : {}),
    ...(iterm && /^[0-9A-Fa-f-]{36}$/.test(iterm) ? { iterm } : {}),
    ...(env.wt && /^[0-9A-Fa-f-]{36}$/.test(env.wt) ? { wt: env.wt } : {}),
  }
}

/** `ps -o tty=` output as a device path: `ttys004` → `/dev/ttys004`; `??` (no terminal) → none. */
export const ttyPath = (ps: string | null): string | undefined => {
  const name = ps?.trim()
  return name && /^tty[\w]+$/.test(name) ? `/dev/${name}` : undefined
}

/**
 * The session a click on a notification brings up. `sessionId` and `pid` name a running session (the pid is
 * checked against `sessions/<pid>.json` at the click, as pids are reused); `terminal` is where it draws.
 * With no running session, the worktree's: found by `branch` on Windows, else resumed or started in `path`.
 */
export type NfClickTarget = {
  sessionId?: string
  pid?: number
  terminal?: NfTerminal
  path: string
  mainRoot: string
  branch?: string
  title: string
}

/** What a click opens: an opaque token looked up in the clicks file, so the link itself names no path. */
export const launchUri = (token: string): string => `nanoflow://open/${token}`

/** A fresh token: 16 hex characters. `random` is Math.random, passed in so a test can pin it. */
export const clickToken = (random: () => number): string =>
  Array.from({ length: 16 }, () => Math.floor(random() * 16).toString(16)).join('')

/** How long a notification stays clickable, and how many the clicks file keeps. */
export const CLICK_KEEP_MS = 7 * 24 * 60 * 60_000
export const CLICK_KEEP_COUNT = 200

export type NfClicks = Record<string, NfClickTarget & { at: number }>

/** The clicks file with `token` added: entries older than CLICK_KEEP_MS dropped, then the newest CLICK_KEEP_COUNT kept. */
export const rememberClick = (stored: Readonly<NfClicks>, token: string, target: NfClickTarget, now: number): NfClicks => {
  const kept = Object.entries(stored).filter(([, c]) => now - c.at < CLICK_KEEP_MS)
  return Object.fromEntries([...kept, [token, { ...target, at: now }] as const].slice(-CLICK_KEEP_COUNT))
}

/** One argument for /bin/sh, in single quotes. */
export const shQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * How macOS shows it. `terminalNotifier`: the `terminal-notifier` tool is installed, the one way a click can do
 * something: osascript's notifications are always Script Editor's, so a click on one opens Script Editor
 * (even inside `tell application id …`, tried on macOS). `app`: the terminal's bundle id, which a
 * terminal-notifier click brings forward should the session's tab not be found.
 */
export type NfMacNotifier = { terminalNotifier: boolean; app?: string }

/** Said once a session on macOS without terminal-notifier. */
export const MAC_CLICK_HINT = 'macOS: to open the session when you click a notification (not Script Editor), run brew install terminal-notifier'

/**
 * The command that shows one notification. Title and body go in as their own arguments, never into a script's
 * source, so no quote, `$` or backtick in them is ever read as code. `launch` is what a click opens.
 */
export const notifyArgv = (
  os: NfOs, pluginRoot: string, title: string, body: string, launch?: string, mac: NfMacNotifier = { terminalNotifier: false },
): string[] => {
  if (os === 'win') return powershellFile(pluginRoot, 'notify.ps1', ['-Title', title, '-Body', body, ...(launch ? ['-Launch', launch] : [])])
  if (os === 'mac') {
    const app = mac.app && BUNDLE_ID.test(mac.app) ? mac.app : undefined
    if (mac.terminalNotifier) {
      return [
        'terminal-notifier', '-title', title, '-message', body,
        ...(app ? ['-activate', app] : []),
        ...(launch ? ['-execute', `/usr/bin/osascript -l JavaScript ${shQuote(`${pluginRoot}/hooks/open-session.js`)} ${shQuote(launch)}`] : []),
      ]
    }
    return ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]
  }
  return ['notify-send', '--app-name=nanoflow', title, body]
}
