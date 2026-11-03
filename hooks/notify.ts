// Desktop notifications: which moments reach the OS (Windows toast, macOS Notification Center) and the
// argv that raises one. Pure: register.tsx runs the argv.

/** What a notification is about: its title, and whether `important` sends it. */
export type NfCategory = 'attention' | 'ci' | 'pr' | 'worktree' | 'failure' | 'turn' | 'service' | 'ticket' | 'activity'

/** all: every category · important: the ones marked so, and anything that failed · off: none. */
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

/** An error is a failure whatever it was about. */
export const categoryOf = (event: { category?: NfCategory; tone: string }): NfCategory =>
  event.tone === 'error' ? 'failure' : (event.category ?? 'activity')

/** `important` is the event's own flag, as for toasts: a repo rule marked important reaches `important` too. */
export const shouldNotify = (level: NfNotifyLevel, category: NfCategory, important = false): boolean =>
  level === 'all' || (level === 'important' && (important || NOTIFY_CATEGORY[category].important))

export const notifyTitle = (category: NfCategory): string => `nanoflow · ${NOTIFY_CATEGORY[category].title}`

export type NfOs = 'win' | 'mac' | 'linux'

/**
 * The command that shows one notification. Title and body go in as their own arguments, never into a script's
 * source, so no quote, `$` or backtick in them is ever read as code.
 */
export const notifyArgv = (os: NfOs, pluginRoot: string, title: string, body: string): string[] => {
  if (os === 'win') {
    return ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${pluginRoot}/hooks/notify.ps1`, '-Title', title, '-Body', body]
  }
  if (os === 'mac') {
    return ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]
  }
  return ['notify-send', '--app-name=nanoflow', title, body]
}
