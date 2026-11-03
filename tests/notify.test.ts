import { describe, expect, mock, test } from 'claude-code/testing'
import {
  categoryOf, claim, CLICK_KEEP_COUNT, CLICK_KEEP_MS, clickToken, desktopImportant, launchUri, notifyArgv, notifyLevelOf, notifyTitle, powershellFile,
  appIsCurrent, rememberClick, shouldNotify, sourceStamp, terminalFrom, ttyPath, NOTIFY_CATEGORY, type NfCategory, type NfClicks,
} from '../hooks/notify'

const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

/**
 * Every notification command the plugin ran; `uname` names `os`, everything else fails quietly, as with no
 * git/gh. Also stands in for the engine beneath the plugin's turn and Notification hooks.
 */
/** A test body's arguments: the engine and `on`. */
type TestBody = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]
type RunResult = typeof ok

/** `other` answers any other command (`which`, `ps`), or a notifier's own run when it should fail. */
const captureNotifications = (on: On, os = 'Windows', other: (argv: readonly string[]) => RunResult | undefined = () => undefined): string[][] => {
  const sent: string[][] = []
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'uname') return { value: { ...ok, stdout: `${os}\n` } }
    const answer = other(e.argv)
    if (e.argv.some(a => a.endsWith('notify.ps1')) || ['osascript', 'notify-send', 'terminal-notifier'].includes(e.argv[0]!)) {
      sent.push([...e.argv])
      return { value: answer ?? ok }
    }
    if (answer) return { value: answer }
    return { value: { ...ok, exitCode: 1 } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.Notification', () => ({ value: {} }))
  on('ui.status', async () => ({ value: undefined }))
  return sent
}

/** nanoflow.app's source as a test reads it: the plugin hashes it to know whether the built app is current. */
const MAC_SOURCE = '// nanoflow.app, in a test'

/** Files in memory for fs.read/write/list, keyed with forward slashes and no drive. */
const fakeFiles = (on: On, initial: Record<string, string> = {}): Record<string, string> => {
  // The drive letter dropped too: on a Windows host the engine makes /Users/me C:/Users/me.
  const key = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  const files: Record<string, string> = Object.fromEntries(Object.entries(initial).map(([path, text]) => [key(path), text]))
  on('fs.read', async (_$, e) => {
    if (key(e.path) in files) return { value: files[key(e.path)]! }
    if (/[\\/]hooks[\\/]mac-notifier\.js$/.test(e.path)) return { value: MAC_SOURCE }
    throw new Error('ENOENT')
  })
  on('fs.write', async (_$, e) => {
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    const dir = `${key(e.path)}/`
    const names = Object.keys(files).filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('/')).map(f => f.slice(dir.length))
    return { value: names.map(name => ({ name, kind: 'file' as const, size: files[dir + name]!.length, mtimeMs: 0, isLink: false })) }
  })
  return files
}

/** The clicks file, wherever the host put the home folder (a Windows host makes /Users/me C:/Users/me). */
const clicksFile = (files: Record<string, string>): string | undefined =>
  Object.entries(files).find(([path]) => path.endsWith('/.claude/nanoflow/clicks.json'))?.[1]

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

  test('a click link reaches the Windows toast only; the clicks file keeps a week, at most CLICK_KEEP_COUNT', () => {
    const uri = launchUri(clickToken(() => 0.99))
    expect(uri).toBe('nanoflow://open/ffffffffffffffff')
    expect(notifyArgv('win', 'C:/p', 't', 'b', uri).slice(-2)).toEqual(['-Launch', uri])
    expect(notifyArgv('win', 'C:/p', 't', 'b')).not.toContain('-Launch')
    const target = { sessionId: 's', path: 'C:/w', mainRoot: 'C:/m', title: 'w' }
    const now = 10 * CLICK_KEEP_MS
    const stored = rememberClick({ old: { ...target, at: now - CLICK_KEEP_MS }, recent: { ...target, at: now - 1000 } }, 'new', target, now)
    expect(Object.keys(stored)).toEqual(['recent', 'new'])
    let many = {}
    for (let i = 0; i < CLICK_KEEP_COUNT + 5; i++) many = rememberClick(many, `t${i}`, target, now)
    expect(Object.keys(many).length).toBe(CLICK_KEEP_COUNT)
    expect(Object.keys(many).at(-1)).toBe(`t${CLICK_KEEP_COUNT + 4}`)
  })

  test('the terminal from the environment: bundle id, iTerm2 session id, Windows Terminal tab; malformed values left out', () => {
    expect(terminalFrom({ bundle: 'com.apple.Terminal', iterm: 'w0t1p0:0B5C7E1A-1111-2222-3333-444455556666', wt: null })).toEqual({
      app: 'com.apple.Terminal', iterm: '0B5C7E1A-1111-2222-3333-444455556666',
    })
    expect(terminalFrom({ bundle: 'x" to do shell script "rm', iterm: 'nonsense', wt: '971f7a07-c00f-44f3-bbcb-6e801c53e882' })).toEqual({
      wt: '971f7a07-c00f-44f3-bbcb-6e801c53e882',
    })
    expect(ttyPath('ttys004\n')).toBe('/dev/ttys004')
    expect(ttyPath('??')).toBeUndefined()
    // A bundle id that is not one is never handed to terminal-notifier.
    expect(notifyArgv('mac', '/p', 't', 'b', undefined, { terminalNotifier: true, app: 'x" & (do shell script "id") & "' })).not.toContain('-activate')
    // The plugin's folder is quoted for the shell terminal-notifier runs -execute in.
    expect(notifyArgv('mac', "/it's", 't', 'b', 'nanoflow://open/0123456789abcdef', { terminalNotifier: true }).at(-1))
      .toBe("/usr/bin/osascript -l JavaScript '/it'\\''s/hooks/open-session.js' 'nanoflow://open/0123456789abcdef'")
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

  test('a Windows toast opens this session on a click: a link with a token, the token naming the session', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' })
    const sent = captureNotifications(on)
    const files = fakeFiles(on, { 'C:/Users/me/.claude/sessions/4242.json': JSON.stringify({ pid: 4242, sessionId: 'sess-1', cwd: 'C:\\proj' }) })
    on('session.id', () => ({ value: 'sess-1' }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
    await settle()
    const argv = sent.at(-1)!
    const launch = argv[argv.indexOf('-Launch') + 1]!
    expect(launch).toMatch(/^nanoflow:\/\/open\/[0-9a-f]{16}$/)
    const clicks = JSON.parse(clicksFile(files)!) as NfClicks
    expect(clicks[launch.split('/').pop()!]).toMatchObject({ sessionId: 'sess-1', pid: 4242, path: 'C:/proj' })
  })

  const ITERM_ID = '0B5C7E1A-1111-2222-3333-444455556666'

  /** A macOS session in iTerm2 (pid 777 on ttys004) that Claude asked for input. */
  /** `app`: how nanoflow.app's build (/bin/sh) and start (open) go; by default neither works, as in a test. */
  const macSession = async (
    $: Engine, on: On, terminalNotifier: boolean,
    app: { builds: boolean; starts: boolean; initial?: Record<string, string> } = { builds: false, starts: false },
  ) => {
    const ran: string[][] = []
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, { HOME: '/Users/me', __CFBundleIdentifier: 'com.googlecode.iterm2', ITERM_SESSION_ID: `w0t1p0:${ITERM_ID}` })
    const sent = captureNotifications(on, 'Darwin', argv => {
      if (argv[0] === 'which') return terminalNotifier ? { ...ok, stdout: '/opt/homebrew/bin/terminal-notifier\n' } : { ...ok, exitCode: 1 }
      if (argv.join(' ') === 'ps -o tty= -p 777') return { ...ok, stdout: 'ttys004\n' }
      if (argv[0] === '/bin/sh' || argv[0] === 'open') {
        ran.push([...argv])
        return (argv[0] === '/bin/sh' ? app.builds : app.starts) ? ok : { ...ok, exitCode: 1, stderr: 'no' }
      }
      return undefined
    })
    const files = fakeFiles(on, {
      '/Users/me/.claude/sessions/777.json': JSON.stringify({ pid: 777, sessionId: 'sess-m', cwd: '/Users/me/proj' }),
      ...app.initial,
    })
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('session.id', () => ({ value: 'sess-m' }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/Users/me/proj', surface: 'terminal', isInteractive: true })
    await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
    // Building the app and handing each notification over take more turns than one settle.
    for (let i = 0; i < 5; i++) await settle()
    return { sent, files, toasts, ran }
  }

  test('macOS with terminal-notifier: a click runs open-session.js; the link names the session, its pid, tty and iTerm2 tab', async ($, on) => {
    const { sent, files } = await macSession($, on, true)
    const argv = sent.at(-1)!
    expect(argv[0]).toBe('terminal-notifier')
    expect(argv[argv.indexOf('-activate') + 1]).toBe('com.googlecode.iterm2')
    const execute = argv[argv.indexOf('-execute') + 1]!
    expect(execute).toMatch(/^\/usr\/bin\/osascript -l JavaScript '.*\/hooks\/open-session\.js' 'nanoflow:\/\/open\/[0-9a-f]{16}'$/)
    const token = /open\/([0-9a-f]{16})/.exec(execute)![1]!
    const clicks = JSON.parse(clicksFile(files)!) as NfClicks
    expect(clicks[token]).toMatchObject({
      sessionId: 'sess-m', pid: 777, path: '/Users/me/proj',
      terminal: { app: 'com.googlecode.iterm2', iterm: ITERM_ID, tty: '/dev/ttys004' },
    })
  })

  test('macOS with terminal-notifier says nothing about installing it', async ($, on) => {
    const { toasts } = await macSession($, on, true)
    expect(toasts.some(t => t.includes('terminal-notifier'))).toBe(false)
  })

  test('macOS without terminal-notifier: plain osascript, no click link, and once a session how to get clicks', async ($, on) => {
    const { sent, files, toasts } = await macSession($, on, false)
    expect(sent.length).toBe(2)
    expect(sent.every(argv => argv[0] === 'osascript')).toBe(true)
    // osascript's notifications are always Script Editor's, whatever app the script names: none named.
    expect(sent.flat().join(' ')).not.toContain('tell application')
    expect(sent.flat().join(' ')).not.toContain('nanoflow://')
    expect(clicksFile(files)).toBeUndefined()
    expect(toasts.filter(t => t.includes('brew install terminal-notifier')).length).toBe(1)
  })

  test('macOS without terminal-notifier: nanoflow.app is built once and posts each notification, which a click opens', async ($, on) => {
    const { sent, files, toasts, ran } = await macSession($, on, false, { builds: true, starts: true })
    expect(sent.length).toBe(0)
    const builds = ran.filter(argv => argv[0] === '/bin/sh')
    expect(builds.length).toBe(1)
    expect(builds[0]![1]).toMatch(/[\\/]hooks[\\/]mac-notifier\.sh$/)
    expect(builds[0]![2]).toMatch(/[\\/]hooks[\\/]mac-notifier\.js$/)
    expect(builds[0]![3]).toMatch(/\/\.claude\/nanoflow\/nanoflow\.app$/)
    const starts = ran.filter(argv => argv[0] === 'open')
    expect(starts.length).toBe(2)
    expect(starts[0]!.slice(0, 3)).toEqual(['open', '-n', '-g'])
    expect(starts[0]!.slice(-2)).toEqual(['--args', 'post'])
    const pending = Object.entries(files).filter(([path]) => /\/pending-\d{15}-[0-9a-f]{16}\.json$/.test(path)).map(([, text]) => JSON.parse(text))
    expect(pending.length).toBe(2)
    expect(pending[0]).toMatchObject({ title: 'nanoflow · Claude needs you', body: expect.stringContaining('waiting for your input') })
    expect(pending[0].launch).toMatch(/^nanoflow:\/\/open\/[0-9a-f]{16}$/)
    // The click target is recorded, as with terminal-notifier.
    expect(JSON.parse(clicksFile(files)!)[pending[0].launch.split('/').pop()]).toMatchObject({ sessionId: 'sess-m', pid: 777 })
    expect(toasts.some(t => t.includes('terminal-notifier'))).toBe(false)
  })

  test('macOS: a built app that carries the source stamp is not built again', async ($, on) => {
    const plist = `<dict>\n\t<key>NanoflowNotifier</key>\n\t<string>${sourceStamp(MAC_SOURCE)}</string>\n</dict>`
    const { ran } = await macSession($, on, false, { builds: true, starts: true, initial: { '/Users/me/.claude/nanoflow/nanoflow.app/Contents/Info.plist': plist } })
    expect(ran.filter(argv => argv[0] === '/bin/sh').length).toBe(0)
    expect(ran.filter(argv => argv[0] === 'open').length).toBe(2)
    expect(appIsCurrent(plist, 'other')).toBe(false)
  })

  test('macOS: an app that will not start hands over to osascript, empties what it left, and is not tried again', async ($, on) => {
    const { sent, files, ran } = await macSession($, on, false, { builds: true, starts: false })
    expect(ran.filter(argv => argv[0] === 'open').length).toBe(1)
    expect(sent.length).toBe(2)
    expect(sent.every(argv => argv[0] === 'osascript')).toBe(true)
    const pending = Object.entries(files).filter(([path]) => /\/pending-/.test(path)).map(([, text]) => text)
    expect(pending).toEqual(['{}'])
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
