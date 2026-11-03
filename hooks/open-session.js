// Bring up the Claude session a clicked macOS notification is about. Run by terminal-notifier's -execute as
//   osascript -l JavaScript open-session.js nanoflow://open/<token>
// The token's entry in ~/.claude/nanoflow/clicks.json (written by the session that raised the notification)
// says which session and terminal; an unknown token does nothing. In order:
//   1. the session still runs: its own tab, by iTerm2 session id or by its tty in iTerm2 / Terminal.app  -> "tab"
//      (in another app, VS Code or the like: that app is brought forward)                              -> "app"
//   2. it has ended: resumed in a new tab, in the folder it ran in                                      -> "resumed"
//   3. no session at all (a worktree nobody works in): a new tab there, running claude                 -> "new"
// JavaScript for Automation, built into macOS: nothing to install. Prints what it did, for the debug log.
ObjC.import('Foundation')

const ITERM = 'com.googlecode.iterm2'
const TERMINAL = 'com.apple.Terminal'
const UUID = /^[0-9A-Fa-f-]{36}$/

function run(argv) {
  const match = /^nanoflow:\/\/open\/([0-9a-f]{16})\/?$/.exec(argv[0] || '')
  if (!match) return 'bad link'
  const env = $.NSProcessInfo.processInfo.environment
  const getEnv = name => {
    const value = env.objectForKey(name)
    return value.isNil() ? '' : ObjC.unwrap(value)
  }
  const home = getEnv('HOME')
  const config = getEnv('CLAUDE_CONFIG_DIR') || `${home}/.claude`

  const readText = path => {
    const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null)
    return text.isNil() ? null : ObjC.unwrap(text)
  }
  const readJson = path => {
    try { return JSON.parse(readText(path)) } catch (e) { return null }
  }
  const exists = path => $.NSFileManager.defaultManager.fileExistsAtPath(path)

  const click = (readJson(`${home}/.claude/nanoflow/clicks.json`) || {})[match[1]]
  if (!click || typeof click.path !== 'string') return 'unknown token'
  const terminal = click.terminal || {}

  const me = Application.currentApplication()
  me.includeStandardAdditions = true
  const sh = command => {
    try { return me.doShellScript(command) } catch (e) { return '' }
  }
  const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`

  // A running session: its sessions/<pid>.json still names it, and the process is there (pids are reused).
  const isLive = (pid, sessionId) => {
    if (!Number.isInteger(pid)) return false
    const record = readJson(`${config}/sessions/${pid}.json`)
    if (!record || (sessionId && record.sessionId !== sessionId)) return false
    return sh(`kill -0 ${pid} 2>/dev/null && echo yes`) === 'yes'
  }
  // The session the click names, else one running in the worktree's folder.
  const findPid = () => {
    if (isLive(click.pid, click.sessionId)) return click.pid
    const names = ObjC.deepUnwrap($.NSFileManager.defaultManager.contentsOfDirectoryAtPathError(`${config}/sessions`, null)) || []
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue
      const record = readJson(`${config}/sessions/${name}`)
      if (!record) continue
      const same = click.sessionId ? record.sessionId === click.sessionId : record.cwd === click.path
      if (same && isLive(record.pid, record.sessionId)) return record.pid
    }
    return null
  }

  const running = bundle => {
    try { return Application(bundle).running() } catch (e) { return false }
  }

  const selectInIterm = (id, tty) => {
    if (!running(ITERM)) return false
    const iterm = Application(ITERM)
    for (const window of iterm.windows()) {
      for (const tab of window.tabs()) {
        for (const session of tab.sessions()) {
          if ((id && session.uniqueId() === id) || (tty && session.tty() === tty)) {
            window.select()
            tab.select()
            session.select()
            iterm.activate()
            return true
          }
        }
      }
    }
    return false
  }

  const selectInTerminal = tty => {
    if (!tty || !running(TERMINAL)) return false
    const app = Application(TERMINAL)
    for (const window of app.windows()) {
      for (const tab of window.tabs()) {
        if (tab.tty() !== tty) continue
        if (window.miniaturized()) window.miniaturized = false
        tab.selected = true
        window.index = 1
        app.activate()
        return true
      }
    }
    return false
  }

  // 1. Still running: its tab.
  const pid = findPid()
  if (pid) {
    // The tty recorded is this pid's only when the click named this very process; else ask ps.
    const recorded = pid === click.pid ? terminal.tty : undefined
    const tty = recorded || (() => {
      const name = sh(`ps -o tty= -p ${pid}`).trim()
      return /^tty\w+$/.test(name) ? `/dev/${name}` : undefined
    })()
    const itermId = pid === click.pid && UUID.test(terminal.iterm || '') ? terminal.iterm : undefined
    if (selectInIterm(itermId, tty) || selectInTerminal(tty)) return 'tab'
    if (terminal.app && running(terminal.app)) {
      Application(terminal.app).activate()
      return 'app'
    }
    return 'running'
  }

  // 2/3. Not running: resume it where it ran, if its transcript is there; else a fresh session.
  const transcript = id => `${config}/projects/${click.path.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
  const resume = UUID.test(click.sessionId || '') && exists(transcript(click.sessionId))
  const command = `cd ${quote(click.path)} && claude${resume ? ` --resume ${click.sessionId}` : ''}`
  if (terminal.app === ITERM || (!terminal.app && running(ITERM))) {
    const iterm = Application(ITERM)
    iterm.activate()
    let window = null
    try { window = iterm.currentWindow() } catch (e) { window = null }
    const session = window ? window.createTabWithDefaultProfile().currentSession() : iterm.createWindowWithDefaultProfile().currentSession()
    session.write({ text: command })
  } else {
    // Terminal.app, also for a session that ran in an app with no tabs to open (VS Code and the like).
    const app = Application(TERMINAL)
    app.activate()
    app.doScript(command)
  }
  return resume ? 'resumed' : 'new'
}
