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
 * The command that shows one notification. Title and body go in as their own arguments, never into a script's
 * source, so no quote, `$` or backtick in them is ever read as code.
 */
export const notifyArgv = (os: NfOs, pluginRoot: string, title: string, body: string): string[] => {
  if (os === 'win') return powershellFile(pluginRoot, 'notify.ps1', ['-Title', title, '-Body', body])
  if (os === 'mac') {
    return ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]
  }
  return ['notify-send', '--app-name=nanoflow', title, body]
}
