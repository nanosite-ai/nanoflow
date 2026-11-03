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

/** Said once a session on macOS when nanoflow.app could not be built: notifications are Script Editor's. */
export const MAC_CLICK_HINT = 'macOS: to open the session when you click a notification (not Script Editor), run brew install terminal-notifier'

/**
 * nanoflow.app, built on the Mac from hooks/mac-notifier.js with osacompile: notifications posted by it are
 * its own, so a click launches it and it opens the session. Nothing to install. It cannot tell which
 * notification was clicked, so a click opens the newest one's session; terminal-notifier, when installed, can.
 */
export const MAC_APP = 'nanoflow.app'

/** A short hash of the app's source: the stamp the built app carries, so a changed source rebuilds it. */
export const sourceStamp = (source: string): string => {
  let hash = 5381
  for (let i = 0; i < source.length; i++) hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0
  return hash.toString(16)
}

/** Whether the built app's Info.plist carries this stamp. */
export const appIsCurrent = (infoPlist: string | null, stamp: string): boolean =>
  infoPlist !== null && new RegExp(`<key>NanoflowNotifier</key>\\s*<string>${stamp}</string>`).test(infoPlist)

/** The command that builds the app: a script of the plugin's under /bin/sh, every value its own argument. */
export const macAppBuildArgv = (pluginRoot: string, appPath: string, stamp: string): string[] =>
  ['/bin/sh', `${pluginRoot}/hooks/mac-notifier.sh`, `${pluginRoot}/hooks/mac-notifier.js`, appPath, stamp]

/** One notification waiting for the app, named so the oldest sorts first: `pending-<ms>-<token>.json`. */
export const pendingName = (now: number, token: string): string => `pending-${String(now).padStart(15, '0')}-${token}.json`

/** The command that has the app post what is waiting: a new copy each time (-n), not brought forward (-g). */
export const macAppPostArgv = (appPath: string): string[] => ['open', '-n', '-g', appPath, '--args', 'post']

/** nanoflow.app's bundle id, as mac-notifier.sh sets it: the name macOS keeps its notification setting under. */
export const MAC_APP_ID = 'ai.nanosite.nanoflow.notifier'

/**
 * Where macOS keeps each app's notification settings, under the home folder: the usernoted group container
 * (macOS 15 and later; tried on 26), then the older ncprefs (whose copy goes stale once the first is in use).
 */
export const MAC_NOTIFICATION_PREFS = [
  'Library/Group Containers/group.com.apple.usernoted/Library/Preferences/group.com.apple.usernoted',
  'Library/Preferences/com.apple.ncprefs',
] as const

/** The command that prints one of those as XML: through cfprefsd, so it is current, not what was last flushed. */
export const macPrefsArgv = (home: string, prefs: string): string[] => ['/usr/bin/defaults', 'export', `${home}/${prefs}`, '-']

/** The "Allow notifications" switch in an app's settings `flags` (on 0x280200e, off 0x80200e, read on macOS 26). */
const MAC_ALLOW_NOTIFICATIONS = 0x2000000

/**
 * Whether macOS lets nanoflow.app's notifications show, from one settings export: false when the person
 * switched it off, or never answered the one-time "allow notifications" request (it shows as a banner, and goes
 * away by itself); undefined when it is not listed or the settings cannot be read, so it is posted anyway: the
 * first post is what makes macOS ask.
 */
export const macAppAllowed = (prefsXml: string | null): boolean | undefined => {
  if (!prefsXml) return undefined
  const at = prefsXml.search(new RegExp(`<key>bundle-id</key>\\s*<string>${MAC_APP_ID.replace(/\./g, '\\.')}</string>`))
  if (at < 0) return undefined
  // Its own keys come sorted after bundle-id: flags before src (whose entries carry flags of their own).
  const rest = prefsXml.slice(at + 1)
  const end = rest.search(/<key>(bundle-id|src)<\/key>/)
  const flags = /<key>flags<\/key>\s*<integer>(\d+)<\/integer>/.exec(end < 0 ? rest : rest.slice(0, end))
  return flags ? (Number(flags[1]) & MAC_ALLOW_NOTIFICATIONS) !== 0 : undefined
}

/** Said once a session when macOS keeps nanoflow.app's notifications from showing: they go through osascript. */
export const MAC_ALLOW_HINT = 'macOS: to open the session when you click a notification, allow notifications from "nanoflow" in System Settings → Notifications'

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
