import { describe, expect, mock, test } from 'claude-code/testing'
import { categoryOf, claim, desktopImportant, notifyArgv, notifyLevelOf, notifyTitle, powershellFile, shouldNotify, NOTIFY_CATEGORY, type NfCategory } from '../hooks/notify'

const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

/**
 * Every notification command the plugin ran; `uname` names `os`, everything else fails quietly, as with no
 * git/gh. Also stands in for the engine beneath the plugin's turn and Notification hooks.
 */
const captureNotifications = (on: Parameters<Parameters<typeof test>[1]>[1], os = 'Windows'): string[][] => {
  const sent: string[][] = []
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'uname') return { value: { ...ok, stdout: `${os}\n` } }
    if (e.argv.some(a => a.endsWith('notify.ps1')) || e.argv[0] === 'osascript' || e.argv[0] === 'notify-send') {
      sent.push([...e.argv])
      return { value: ok }
    }
    return { value: { ...ok, exitCode: 1 } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.Notification', () => ({ value: {} }))
  on('ui.status', async () => ({ value: undefined }))
  return sent
}

/** The notification runs unawaited: let it settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 1000; i++) await Promise.resolve()
}

const turn = { answer: 'done', durationMs: 1000, reason: 'answer' } as const

describe('desktop notification levels', () => {
  test('all sends every category, important only the important ones, off none', () => {
    const categories = Object.keys(NOTIFY_CATEGORY) as NfCategory[]
    expect(categories.every(c => shouldNotify('all', c))).toBe(true)
    expect(categories.some(c => shouldNotify('off', c, true))).toBe(false)
    expect(categories.filter(c => shouldNotify('important', c))).toEqual(['attention', 'ci', 'pr', 'worktree', 'failure'])
    // An event the repo marked important reaches `important` whatever its category, as toasts do.
    expect(shouldNotify('important', 'activity', true)).toBe(true)
  })

  test('an event keeps its category; an uncategorized error is a failure, the rest activity; an unknown level is all', () => {
    expect(categoryOf({ tone: 'error', category: 'ci', important: true })).toBe('ci')
    expect(categoryOf({ tone: 'error', important: true })).toBe('failure')
    expect(categoryOf({ tone: 'success', category: 'pr', important: true })).toBe('pr')
    expect(categoryOf({ tone: 'info', important: false })).toBe('activity')
    // A repo rule marked important counts; a pane action (categorized activity) does not, though its toast does.
    expect(desktopImportant({ tone: 'success', important: true })).toBe(true)
    expect(desktopImportant({ tone: 'success', important: true, category: 'activity' })).toBe(false)
    expect(notifyLevelOf('important')).toBe('important')
    expect(notifyLevelOf(undefined)).toBe('all')
    expect(notifyTitle('ci')).toBe('nanoflow · CI')
  })

  test('the text reaches the command as arguments, never as script source', () => {
    const body = `it's "PR #3" $HOME \`x\``
    const win = notifyArgv('win', 'C:/p', 't', body)
    expect(win.slice(-4)).toEqual(['-Title', 't', '-Body', body])
    expect(win).toContain('C:/p/hooks/notify.ps1')
    const mac = notifyArgv('mac', '/p', 't', body)
    expect(mac[0]).toBe('osascript')
    expect(mac.slice(-2)).toEqual(['t', body])
    expect(mac.slice(1, -2).join(' ')).not.toContain(body)
    expect(notifyArgv('linux', '/p', 't', body)).toEqual(['notify-send', '--app-name=nanoflow', 't', body])
    expect(powershellFile('C:/p', 'open-session.ps1', ['-Path', 'x'])).toEqual(
      ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:/p/hooks/open-session.ps1', '-Path', 'x'],
    )
  })

  test('claim: a key is new once within the window, old keys are pruned, others stay independent', () => {
    const first = claim({}, 'service:A up', 1000, 5000)
    expect(first.isNew).toBe(true)
    const other = claim(first.recent, 'service:B up', 2000, 5000)
    expect(other.isNew).toBe(true)
    expect(claim(other.recent, 'service:A up', 3000, 5000).isNew).toBe(false)
    const later = claim(other.recent, 'service:A up', 6000, 5000)
    expect(later.isNew).toBe(true)
    expect(Object.keys(later.recent)).toEqual(['service:B up', 'service:A up'])
  })
})

describe('desktop notifications in a session', () => {
  test('Claude waiting for you notifies on Windows, every ask; other notification types do not', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, { OS: 'Windows_NT' })
    const sent = captureNotifications(on)
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
    await $.classic.Notification({ message: 'Signed in', notification_type: 'auth_success' })
    await settle()
    expect(sent.length).toBe(2)
    expect(sent[0]).toContain('nanoflow · Claude needs you')
    expect(sent[0]?.at(-1)).toContain('Claude needs your permission to use Bash')
  })

  test('on macOS it goes through osascript', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, {})
    const sent = captureNotifications(on, 'Darwin')
    await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
    await settle()
    expect(sent[0]?.[0]).toBe('osascript')
  })

  test('a finished turn notifies at all', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, { OS: 'Windows_NT' })
    const sent = captureNotifications(on)
    await $.turn.complete(turn)
    await settle()
    expect(sent.some(argv => argv.includes('nanoflow · Claude finished'))).toBe(true)
  })

  test('important skips a finished turn but not Claude waiting for you', { options: { desktopNotifications: 'important' } }, async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, { OS: 'Windows_NT' })
    const sent = captureNotifications(on)
    await $.turn.complete(turn)
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
    await settle()
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('nanoflow · Claude needs you')
  })

  test('off sends nothing', { options: { desktopNotifications: 'off' } }, async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, { OS: 'Windows_NT' })
    const sent = captureNotifications(on)
    await $.turn.complete(turn)
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
    await settle()
    expect(sent.length).toBe(0)
  })

  test('the idle prompt right after "Claude finished" is not said twice', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, { OS: 'Windows_NT' })
    const sent = captureNotifications(on)
    await $.turn.complete(turn)
    await settle()
    await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
    await settle()
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('nanoflow · Claude finished')
  })

  test('a notifier that cannot start is not tried again', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, {})
    let tries = 0
    on('process.run', async (_$, e) => {
      if (e.argv[0] === 'uname') return { value: { ...ok, stdout: 'Linux\n' } }
      if (e.argv[0] === 'notify-send') {
        tries++
        throw new Error('spawn notify-send ENOENT')
      }
      return { value: { ...ok, exitCode: 1 } }
    })
    on('classic.Notification', () => ({ value: {} }))
    await $.classic.Notification({ message: 'one', notification_type: 'permission_prompt' })
    await settle()
    await $.classic.Notification({ message: 'two', notification_type: 'permission_prompt' })
    await settle()
    expect(tries).toBe(1)
  })
})
