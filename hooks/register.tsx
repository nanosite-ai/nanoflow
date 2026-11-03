// nanoflow: the dev workflow, live. A dashboard pane, a progress status line and toasts, fed by the repo's
// provider command (e.g. `ns flow --json`) or the built-in git/gh scanner, plus the session's own tool calls.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiOpenResult } from 'claude-code'
import type { NfActivity, NfCheck, NfService, NfSnapshot, NfSource, NfTab, NfTicket, NfWorktree } from '../types'
import { ACTION, DEFAULT_CONFIG, fillTemplate, mergeConfig, starterConfig, type NfActionKey, type NfConfig } from './config'
import { diffSnapshots, mergeLocal, ticketLabel, worktreeTitle, type NfEvent } from './diff'
import {
  ATTENTION_TYPES, categoryOf, claim, clickToken, desktopImportant, IDLE_AFTER_TURN_MS, launchUri, notifyArgv, notifyLevelOf, notifyTitle, powershellFile,
  appIsCurrent, MAC_ALLOW_HINT, MAC_APP, MAC_CLICK_HINT, MAC_NOTIFICATION_PREFS, macAppAllowed, macAppBuildArgv, macAppPostArgv, macPrefsArgv, pendingName, rememberClick, shouldNotify, sourceStamp, terminalFrom, ttyPath,
  type NfCategory, type NfClicks, type NfClickTarget, type NfMacNotifier, type NfNotifyLevel, type NfOs, type NfTerminal,
} from './notify'
import { statusLine } from './progress'
import { browserEventOf, causeOf, CHECK_KINDS, matchRule, outputDetail, shortCommand, toastFor } from './rules'
import {
  applyFlowResult, baseName, buildFlowQuery, focusFrom, isInside, isSnapshot, normalizePath, parseJson, parseWorktreeList, quoteForCmd, samePath, serviceUrl,
  featureOf, slugFromRemote, ticketKeyOf, ticketNumber, ticketUrl, withFocus, type GitWorktree, type GqlRepo,
} from './scan'
import { isUsage, usageCommands } from './usage'
import { PaneView, type PaneHandlers } from './view'
import { registerSecrets, secretCount, startSecrets } from './secrets/register'

type $ = EngineInterface

const PANE = 'nanoflow'
const COMMAND = 'nanoflow'
const ACTIVITY_LIMIT = 50
const ACTION_TIMEOUT_MS = 600_000

const snapshotAtom = atom({ plugin: 'nanoflow', key: 'snapshot' } as const, null)
const activityAtom = atom({ plugin: 'nanoflow', key: 'activity' } as const, [])
const checksAtom = atom({ plugin: 'nanoflow', key: 'checks' } as const, {})
const browserAtom = atom({ plugin: 'nanoflow', key: 'browserOpen' } as const, false)
const skillAtom = atom({ plugin: 'nanoflow', key: 'skill' } as const, null)
const tabAtom = atom({ plugin: 'nanoflow', key: 'tab' } as const, 'worktrees')
const selectedAtom = atom({ plugin: 'nanoflow', key: 'selected' } as const, null)
const expandedAtom = atom({ plugin: 'nanoflow', key: 'expanded' } as const, null)
const busyAtom = atom({ plugin: 'nanoflow', key: 'busy' } as const, null)
const sourceAtom = atom({ plugin: 'nanoflow', key: 'source' } as const, { config: 'defaults', provider: null, error: null })
const focusAtom = atom({ plugin: 'nanoflow', key: 'focus' } as const, null)
const usageAtom = atom({ plugin: 'nanoflow', key: 'usage' } as const, null)

/** Module state: what the hooks share. Reset by a reload; the drawn data lives in $.state. */
const S = {
  config: DEFAULT_CONFIG as NfConfig,
  cwd: '',
  running: null as string | null,
  scanning: null as Promise<void> | null,
  wantsFull: false,
  providerWarned: false,
  toastLevel: 'all' as NfNotifyLevel,
  desktopLevel: 'all' as NfNotifyLevel,
  /** False for a `-p` run, the SDK, a scheduled job: no one to notify. */
  isInteractive: true,
  /** Desktop notifications sent lately by this session, `category:text` → when. */
  notified: {} as Record<string, number>,
  notifyQueue: Promise.resolve() as Promise<void>,
  notifierMissing: false,
  /** When "Claude finished" last went: the idle prompt that follows it says nothing new. */
  turnNotifiedAt: 0,
  /** This session's Claude process and the terminal it draws in: what a click on a notification goes back to. */
  pid: undefined as number | undefined,
  terminal: undefined as NfTerminal | undefined,
  /** Whether macOS has terminal-notifier; undefined until asked. */
  terminalNotifier: undefined as boolean | undefined,
  /** The terminal-notifier hint was shown this session. */
  macHintShown: false,
  /** nanoflow.app's path when built and working, null when not; undefined until tried. */
  macApp: undefined as string | null | undefined,
  version: undefined as string | null | undefined,
  /** The usage read in flight, and when the last one began (reads after a turn wait USAGE_GAP_MS). */
  usageReading: null as Promise<void> | null,
  usageAt: 0,
  /** The usage command that answered last; null to try each in turn. */
  usageArgv: null as readonly string[] | null,
  /** No usage command answered: reads after a turn wait for the next full refresh. */
  usageMissing: false,
}

// ─── host I/O: git, gh, the provider, liveness probes ($ cannot cross an import, so it all lives here) ──

const PROVIDER_TIMEOUT_MS = 60_000
const PROBE_TIMEOUT_MS = 1500

let isWindowsCache: boolean | undefined
const isWindows = async ($: $): Promise<boolean> => {
  isWindowsCache ??= (await $.env.get('OS')) === 'Windows_NT'
  return isWindowsCache
}

let osCache: NfOs | undefined
const hostOs = async ($: $): Promise<NfOs> => {
  if (osCache) return osCache
  if (await isWindows($)) return (osCache = 'win')
  return (osCache = (await runText($, ['uname', '-s'])) === 'Darwin' ? 'mac' : 'linux')
}

/**
 * Run argv on the host. On Windows a CLI installed by npm is a `.cmd` shim that only a shell can start,
 * so a command that cannot be started directly is retried through cmd.exe.
 */
const runCommand = async (
  $: $,
  argv: readonly string[],
  init: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  try {
    return await $.process.run(argv, init)
  } catch (error) {
    if (!(await isWindows($))) throw error
    return $.process.run(['cmd.exe', '/d', '/s', '/c', argv.map(quoteForCmd).join(' ')], init)
  }
}

const runText = async ($: $, argv: readonly string[], cwd?: string): Promise<string | null> => {
  try {
    const { exitCode, stdout } = await runCommand($, argv, cwd ? { cwd } : {})
    return exitCode === 0 ? stdout.trim() : null
  } catch {
    return null
  }
}

/** One run of the provider command. Throws a one-line reason so the caller can say why, once. */
const providerSnapshot = async ($: $, argv: readonly string[], cwd: string): Promise<NfSnapshot> => {
  const { exitCode, stdout, stderr } = await runCommand($, argv, { cwd, timeoutMs: PROVIDER_TIMEOUT_MS })
  if (exitCode !== 0) throw new Error(`${argv.join(' ')} exited ${exitCode}: ${(stderr || stdout).trim().split('\n').pop() ?? ''}`)
  const parsed = parseJson<unknown>(stdout)
  if (!isSnapshot(parsed)) throw new Error(`${argv.join(' ')} did not print a nanoflow snapshot`)
  return parsed
}

const probe = async ($: $, url: string): Promise<boolean> => {
  const timeout = $.clock.sleep(PROBE_TIMEOUT_MS).then(() => false, () => false)
  const fetched = $.http.fetch(url).then(() => true, () => false)
  return Promise.race([fetched, timeout])
}

const servicesFor = async ($: $, slot: number | null): Promise<NfService[]> => {
  if (slot === null) return []
  return Promise.all(
    S.config.services.map(async spec => {
      const port = spec.base + slot * spec.step
      return {
        name: spec.name,
        port,
        url: serviceUrl(S.config.host, port),
        isUp: await probe($, serviceUrl(S.config.host, port, spec.path ?? '/')),
      }
    }),
  )
}

const slotOf = async ($: $, path: string, isMain: boolean): Promise<number | null> => {
  const meta = parseJson<Record<string, unknown>>(await $.fs.read(`${path}/${S.config.slot.file}`).catch(() => null))
  const slot = meta?.[S.config.slot.key]
  if (typeof slot === 'number') return slot
  return isMain ? S.config.slot.mainSlot : null
}

const localWorktree = async ($: $, wt: GitWorktree, mainRoot: string, win: boolean): Promise<NfWorktree> => {
  const isMain = samePath(wt.path, mainRoot, win)
  const name = baseName(wt.path)
  const [slot, status, ahead] = await Promise.all([
    slotOf($, wt.path, isMain),
    runText($, ['git', 'status', '--porcelain', '--ignore-submodules=dirty'], wt.path),
    isMain || !wt.branch ? Promise.resolve('0') : runText($, ['git', 'rev-list', '--count', `${S.config.mainBranch}..${wt.branch}`], wt.path),
  ])
  const key = ticketKeyOf(S.config, wt.branch, name)
  return {
    name,
    path: wt.path,
    branch: wt.branch,
    isMain,
    isCurrent: false,
    slot,
    dirty: status ? status.split(/\r?\n/).filter(Boolean).length : 0,
    ahead: Number(ahead ?? 0) || 0,
    services: await servicesFor($, slot),
    ticket: key === null ? null : { number: ticketNumber(key), key, title: null, url: ticketUrl(S.config, key, null), state: null, status: null, worktree: name },
    pr: null,
  }
}

/** Titles, PRs + CI and the open tickets for every worktree, in one GraphQL call. */
const githubFill = async ($: $, mainRoot: string, trees: NfWorktree[]): Promise<NfTicket[] | null> => {
  const slug = S.config.github.repo ?? slugFromRemote((await runText($, ['git', 'remote', 'get-url', 'origin'], mainRoot)) ?? '')
  if (!slug) return null
  const [owner, name] = slug.split('/')
  const issues = S.config.ticket.tracker === 'github'
  const out = await runText($, ['gh', 'api', 'graphql', '-f', `query=${buildFlowQuery(trees, issues)}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '--jq', '.data.repository'], mainRoot)
  const data = parseJson<GqlRepo>(out)
  const board = data ? applyFlowResult(S.config, trees, data) : null
  // The tickets list is GitHub's open issues: none to show when tickets live elsewhere.
  return issues ? board : null
}

/** The built-in scanner (any git repo): worktrees + slot ports + liveness; with `full`, also gh. */
const builtinSnapshot = async ($: $, full: boolean): Promise<NfSnapshot> => {
  const win = await isWindows($)
  const porcelain = await runText($, ['git', 'worktree', 'list', '--porcelain'], S.cwd)
  if (porcelain === null) throw new Error('not a git repository')
  const git = parseWorktreeList(porcelain)
  const mainRoot = git[0]?.path ?? normalizePath(S.cwd)
  const trees = await Promise.all(git.map(wt => localWorktree($, wt, mainRoot, win)))
  const containing = trees.filter(t => isInside(S.cwd, t.path, win)).sort((a, b) => b.path.length - a.path.length)[0]
  for (const t of trees) t.isCurrent = t === containing
  // PRs and CI come from GitHub whatever the tracker; githubFill skips the issues when tickets live elsewhere.
  const board = full ? await githubFill($, mainRoot, trees) : null
  return {
    version: 1,
    generatedAt: new Date(await $.clock.now()).toISOString(),
    mainRoot,
    current: containing?.path ?? null,
    worktrees: trees,
    board,
  }
}

/** This plugin's version, from its manifest; null when it states none. */
const pluginVersion = async ($: $): Promise<string | null> => {
  const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => null)
  try {
    const { version } = JSON.parse(text ?? '{}') as { version?: unknown }
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

const mainRootOf = async ($: $, cwd: string): Promise<string | null> => {
  const porcelain = await runText($, ['git', 'worktree', 'list', '--porcelain'], cwd)
  return porcelain ? (parseWorktreeList(porcelain)[0]?.path ?? null) : null
}

const checkoutRootOf = async ($: $, cwd: string): Promise<string | null> => {
  const top = await runText($, ['git', 'rev-parse', '--show-toplevel'], cwd)
  return top ? normalizePath(top) : null
}

// ─── output ──────────────────────────────────────────────────────────────────────────────────────

const refreshStatus = async ($: $): Promise<void> => {
  $.ui.status(statusLine({
    snapshot: await read($, snapshotAtom),
    checks: await read($, checksAtom),
    running: S.running,
    skill: await read($, skillAtom),
    secrets: await secretCount($),
  }))
}

/**
 * Into the activity feed, a toast and a desktop notification, each by its own level. `shared` marks an event
 * every open session sees (a snapshot change): one session sends its desktop notification, not each.
 */
const emit = async ($: $, event: NfEvent, shared = false): Promise<void> => {
  const entry: NfActivity = {
    at: await $.clock.now(), icon: event.icon, text: event.text, tone: event.tone,
    ...(event.href ? { href: event.href } : {}), ...(event.detail ? { detail: event.detail } : {}),
  }
  await update($, activityAtom, list => [...list, entry].slice(-ACTIVITY_LIMIT))
  if (shouldNotify(S.toastLevel, categoryOf(event), event.important)) {
    $.ui.toast(`${event.icon} ${event.text}${event.detail && event.tone === 'error' ? ' · full output in ⚡ Activity' : ''}`)
  }
  const about = event.worktree ? (await read($, snapshotAtom))?.worktrees.find(wt => wt.path === event.worktree) : undefined
  pushDesktop($, categoryOf(event), `${event.icon} ${event.text}`, { important: desktopImportant(event), shared, about })
}

/** The same notification again this soon, from this session, is dropped. */
const NOTIFY_REPEAT_MS = 5000
/** A shared event another session already sent this long ago is dropped (a poll is at most 5 min apart). */
const NOTIFY_SHARED_MS = 10 * 60_000
const NOTIFY_TIMEOUT_MS = 10_000

/** Which session it came from: the focused worktree's title, else the folder. */
const sessionLabel = async ($: $): Promise<string> => {
  const wt = (await read($, snapshotAtom))?.worktrees.find(w => w.isCurrent)
  return wt ? worktreeTitle(wt) : S.cwd ? baseName(S.cwd) : 'nanoflow'
}

/**
 * Claims `key` in the machine-wide list of shared notifications sent lately, so of every session that saw
 * the event only the first sends it. A file, as every session runs in its own process.
 */
const claimShared = async ($: $, key: string, now: number): Promise<boolean> => {
  const dir = await nanoflowDir($)
  if (!dir) return true
  const file = `${dir}/notified.json`
  const stored = parseJson<Record<string, number>>(await $.fs.read(file).catch(() => '{}')) ?? {}
  const { isNew, recent } = claim(stored, key, now, NOTIFY_SHARED_MS)
  if (isNew) await $.fs.write(file, JSON.stringify(recent))
  return isNew
}

const nanoflowDir = async ($: $): Promise<string | null> => {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home.replace(/\\/g, '/')}/.claude/nanoflow` : null
}

/** Claude's own folder: where `sessions/<pid>.json` records each running session. */
const claudeDir = async ($: $): Promise<string | null> => {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config) return config.replace(/\\/g, '/')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home.replace(/\\/g, '/')}/.claude` : null
}

type LiveSession = { pid: number; sessionId: string; cwd: string }

/** The running Claude sessions, from the record each keeps under sessions/ (named by its pid). */
const liveSessions = async ($: $): Promise<LiveSession[]> => {
  const dir = await claudeDir($)
  if (!dir) return []
  const entries = await $.fs.list(`${dir}/sessions`).catch(() => [])
  const found: LiveSession[] = []
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry.name)) continue
    const record = parseJson<Partial<LiveSession>>(await $.fs.read(`${dir}/sessions/${entry.name}`).catch(() => ''))
    if (record && typeof record.pid === 'number' && typeof record.sessionId === 'string' && typeof record.cwd === 'string') {
      found.push({ pid: record.pid, sessionId: record.sessionId, cwd: record.cwd })
    }
  }
  return found
}

/** This session's terminal, read once: the environment does not change under a running process. */
const ownTerminal = async ($: $): Promise<NfTerminal> => {
  S.terminal ??= terminalFrom({
    bundle: await $.env.get('__CFBundleIdentifier'), iterm: await $.env.get('ITERM_SESSION_ID'), wt: await $.env.get('WT_SESSION'),
  })
  if (S.terminal.tty === undefined && S.pid && (await hostOs($)) === 'mac') {
    const tty = ttyPath(await runText($, ['ps', '-o', 'tty=', '-p', String(S.pid)]))
    if (tty) S.terminal = { ...S.terminal, tty }
  }
  return S.terminal
}

/**
 * What a click on the notification brings up, with what is known now so the click has less to find:
 * - about another worktree: the session running in it (its pid), else that worktree's, found by its branch;
 * - else this session: its id, pid and terminal. The main checkout's branch names too many tabs to find one by.
 */
const clickTarget = async ($: $, about: NfWorktree | undefined): Promise<NfClickTarget> => {
  const snapshot = await read($, snapshotAtom)
  const mainRoot = snapshot?.mainRoot ?? S.cwd
  const win = await isWindows($)
  const branchOf = (wt: NfWorktree | undefined): { branch?: string } => (wt?.branch && !wt.isMain ? { branch: wt.branch } : {})
  const sessions = await liveSessions($)
  if (about && !about.isCurrent) {
    const there = sessions.find(s => samePath(s.cwd, about.path, win))
    return {
      ...(there ? { sessionId: there.sessionId, pid: there.pid } : {}),
      path: about.path, mainRoot, title: worktreeTitle(about), ...branchOf(about),
    }
  }
  const sessionId = await $.session.id()
  S.pid ??= sessions.find(s => s.sessionId === sessionId)?.pid
  const current = snapshot?.worktrees.find(wt => wt.isCurrent)
  const terminal = await ownTerminal($)
  // S.cwd, where this session started: a resume has to begin there to find its transcript.
  return {
    sessionId, ...(S.pid ? { pid: S.pid } : {}), ...(Object.keys(terminal).length ? { terminal } : {}),
    path: S.cwd, mainRoot, title: await sessionLabel($), ...branchOf(current),
  }
}

/** Whether macOS has `terminal-notifier`, the one notifier a click can run something from. Asked once. */
const macNotifier = async ($: $): Promise<NfMacNotifier> => {
  S.terminalNotifier ??= (await runText($, ['which', 'terminal-notifier'])) !== null
  const { app } = await ownTerminal($)
  return { terminalNotifier: S.terminalNotifier, ...(app ? { app } : {}) }
}

/**
 * nanoflow.app's path once it is built and current, else null (no home, no source, or the build failed: the
 * notification goes through osascript). Built again when its source changed. Decided once a session.
 */
const macApp = async ($: $): Promise<string | null> => {
  if (S.macApp !== undefined) return S.macApp
  S.macApp = null
  const dir = await nanoflowDir($)
  const source = await $.fs.read(`${$.plugin.root}/hooks/mac-notifier.js`).catch(() => null)
  if (!dir || source === null) return null
  const appPath = `${dir}/${MAC_APP}`
  const stamp = sourceStamp(source)
  if (!appIsCurrent(await $.fs.read(`${appPath}/Contents/Info.plist`).catch(() => null), stamp)) {
    const { exitCode, stderr } = await $.process.run(macAppBuildArgv($.plugin.root, appPath, stamp), { timeoutMs: MAC_APP_BUILD_TIMEOUT_MS })
      .catch(error => ({ exitCode: -1, stderr: String(error) }))
    if (exitCode !== 0) {
      $.ui.log(`could not build ${MAC_APP}, notifications go through osascript: ${stderr.trim()}`, { to: 'debug' })
      return null
    }
  }
  return (S.macApp = appPath)
}

const MAC_APP_BUILD_TIMEOUT_MS = 60_000

/**
 * Whether macOS shows nanoflow.app's notifications. When it does not (switched off, or its one-time request
 * went unanswered), the notification goes through osascript instead, where it is seen. Read each time, as the
 * person may switch it on mid-session; true when the settings say nothing.
 */
const macAppShows = async ($: $): Promise<boolean> => {
  const home = await $.env.get('HOME')
  if (!home) return true
  for (const prefs of MAC_NOTIFICATION_PREFS) {
    const allowed = macAppAllowed(await runText($, macPrefsArgv(home, prefs)))
    if (allowed !== undefined) return allowed
  }
  return true
}

/**
 * Hands the notification to nanoflow.app: a pending file it posts and deletes, then the app started to post
 * it. False when the app would not start, so osascript sends it instead (the file is emptied: never posted
 * twice) and the app is not tried again this session.
 */
const postWithMacApp = async ($: $, appPath: string, title: string, body: string, launch: string | undefined, now: number): Promise<boolean> => {
  const dir = await nanoflowDir($)
  if (!dir) return false
  const file = `${dir}/${pendingName(now, launch?.split('/').pop() ?? clickToken(Math.random))}`
  await $.fs.write(file, JSON.stringify({ title, body, ...(launch ? { launch, root: $.plugin.root } : {}) }))
  const { exitCode, stderr } = await $.process.run(macAppPostArgv(appPath), { timeoutMs: NOTIFY_TIMEOUT_MS })
    .catch(error => ({ exitCode: -1, stderr: String(error) }))
  if (exitCode === 0) return true
  await $.fs.write(file, '{}').catch(() => undefined)
  $.ui.log(`${MAC_APP} did not start, notifications go through osascript: ${stderr.trim()}`, { to: 'debug' })
  S.macApp = null
  return false
}

/** Remembers the click target under a fresh token; the link to put on the notification, or none without a home. */
const clickLaunch = async ($: $, about: NfWorktree | undefined, now: number): Promise<string | undefined> => {
  const dir = await nanoflowDir($)
  if (!dir) return undefined
  const file = `${dir}/clicks.json`
  const token = clickToken(Math.random)
  const stored = parseJson<NfClicks>(await $.fs.read(file).catch(() => '{}')) ?? {}
  await $.fs.write(file, JSON.stringify(rememberClick(stored, token, await clickTarget($, about), now)))
  return launchUri(token)
}

const sendDesktop = async ($: $, category: NfCategory, text: string, shared: boolean, about: NfWorktree | undefined): Promise<void> => {
  const now = await $.clock.now()
  const key = `${category}:${text}`
  // Claude asking twice is two asks: never folded.
  if (category !== 'attention') {
    const local = claim(S.notified, key, now, NOTIFY_REPEAT_MS)
    S.notified = local.recent
    if (!local.isNew) return
  }
  if (shared && !(await claimShared($, key, now))) return
  if (category === 'turn') S.turnNotifiedAt = now
  const os = await hostOs($)
  const mac = os === 'mac' ? await macNotifier($) : undefined
  // On macOS without terminal-notifier: nanoflow.app, built here once.
  const built = mac && !mac.terminalNotifier ? await macApp($) : null
  const appPath = built && (await macAppShows($)) ? built : null
  // A click opens the session from a Windows toast, terminal-notifier, or nanoflow.app.
  const clickable = os === 'win' || mac?.terminalNotifier === true || appPath !== null
  const launch = clickable ? await clickLaunch($, about, now).catch(() => undefined) : undefined
  const title = notifyTitle(category)
  if (appPath && (await postWithMacApp($, appPath, title, text, launch, now))) return
  // Straight to the program, never through cmd.exe: its %VAR% expansion would rewrite the text.
  const { exitCode, stderr } = await $.process.run(notifyArgv(os, $.plugin.root, title, text, launch, mac), { timeoutMs: NOTIFY_TIMEOUT_MS })
  if (exitCode !== 0) $.ui.log(`desktop notification failed (exit ${exitCode}): ${stderr.trim()}`, { to: 'debug' })
  if (mac && !mac.terminalNotifier && !S.macHintShown) {
    S.macHintShown = true
    // The app works but macOS hides its notifications: the setting is what is missing, not terminal-notifier.
    $.ui.toast(`💡 ${S.macApp ? MAC_ALLOW_HINT : MAC_CLICK_HINT}`)
  }
}

/**
 * A native notification outside the terminal (Windows toast, macOS Notification Center, notify-send), when
 * the desktopNotifications level takes the category and a person is there to see it. Queued one at a time, so
 * a burst starts no pile of processes; a notifier that cannot start is not tried again this session.
 */
const pushDesktop = (
  $: $, category: NfCategory, text: string,
  { important = false, shared = false, about }: { important?: boolean; shared?: boolean; about?: NfWorktree } = {},
): void => {
  if (!S.isInteractive || S.notifierMissing || !shouldNotify(S.desktopLevel, category, important)) return
  S.notifyQueue = S.notifyQueue
    .then(() => (S.notifierMissing ? undefined : sendDesktop($, category, text, shared, about)))
    .catch(error => {
      S.notifierMissing = true
      $.ui.log(`desktop notifications off for this session, the notifier did not start: ${String(error)}`, { to: 'debug' })
    })
}

// ─── config + scanning ───────────────────────────────────────────────────────────────────────────

const loadConfig = async ($: $): Promise<void> => {
  const checkout = await checkoutRootOf($, S.cwd)
  const main = await mainRootOf($, S.cwd)
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const candidates = [
    checkout && `${checkout}/.claude/nanoflow.json`,
    main && `${main}/.claude/nanoflow.json`,
    home && main && `${home.replace(/\\/g, '/')}/.claude/nanoflow/${baseName(main)}.json`,
  ].filter((p): p is string => Boolean(p))
  for (const path of [...new Set(candidates)]) {
    const text = await $.fs.read(path).catch(() => null)
    if (text === null) continue
    try {
      S.config = mergeConfig(JSON.parse(text))
      await update($, sourceAtom, () => ({ config: path, provider: S.config.provider ? S.config.provider.snapshot.join(' ') : null, error: null }))
    } catch (error) {
      S.config = DEFAULT_CONFIG
      await update($, sourceAtom, () => ({ config: path, provider: null, error: `${path} is not valid JSON: ${String(error)}` }))
    }
    return
  }
  S.config = DEFAULT_CONFIG
  await update($, sourceAtom, () => ({ config: 'defaults', provider: null, error: null }))
}

const snapshotFor = async ($: $, full: boolean): Promise<NfSnapshot> => {
  if (S.config.provider) {
    const argv = full ? S.config.provider.snapshot : (S.config.provider.local ?? S.config.provider.snapshot)
    try {
      const snapshot = await providerSnapshot($, argv, S.cwd)
      if (S.providerWarned) {
        S.providerWarned = false
        await update($, sourceAtom, s => ({ ...s, error: null }))
      }
      return snapshot
    } catch (error) {
      if (!S.providerWarned) {
        S.providerWarned = true
        const reason = error instanceof Error ? error.message : String(error)
        await update($, sourceAtom, s => ({ ...s, error: `provider failed, using git/gh: ${reason}` }))
        await emit($, { icon: '⚠️', text: `nanoflow provider failed (${reason}); falling back to git/gh`, tone: 'warning', important: true, category: 'failure' })
      }
    }
  }
  return builtinSnapshot($, full)
}

const scan = async ($: $, full: boolean): Promise<void> => {
  const prev = await read($, snapshotAtom)
  const fresh = await snapshotFor($, full)
  const next = withFocus(full ? fresh : mergeLocal(prev, fresh), await read($, focusAtom), await isWindows($))
  const events = diffSnapshots(prev, next, await read($, browserAtom))
  await update($, snapshotAtom, () => next)
  for (const event of events) await emit($, event, true)
  await refreshStatus($)
}

const USAGE_GAP_MS = 30_000
/** Off the scan lock, so a slow first read (no cache yet, months of transcripts) delays nothing. */
const USAGE_TIMEOUT_MS = 120_000

/**
 * Each session's tokens, from `<cli> usage --json` (transcripts are often over the 4 MiB one read takes, so
 * the CLI reads them): the provider's CLI first, then `nanoflow`. One read at a time; `soon` (after a turn)
 * skips a read within USAGE_GAP_MS of the last, and any read while no CLI answered: a full refresh tries again.
 */
const refreshUsage = ($: $, soon = false): Promise<void> => {
  if (S.usageReading) return S.usageReading
  S.usageReading = (async () => {
    try {
      const now = await $.clock.now()
      if (soon && (S.usageMissing || now - S.usageAt < USAGE_GAP_MS)) return
      S.usageAt = now
      const where = (await read($, snapshotAtom))?.mainRoot ?? S.cwd
      const reasons: string[] = []
      for (const argv of S.usageArgv ? [S.usageArgv] : usageCommands(S.config.provider?.snapshot)) {
        const ran = await runCommand($, argv, { cwd: where, timeoutMs: USAGE_TIMEOUT_MS }).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
        const parsed = ran.exitCode === 0 ? parseJson<unknown>(ran.stdout) : null
        if (isUsage(parsed)) {
          S.usageArgv = argv
          S.usageMissing = false
          await update($, usageAtom, () => parsed)
          return
        }
        // A snapshot that does not parse may have been cut at the 4 MiB stdout limit: say so rather than nothing.
        const why = ran.exitCode === 0
          ? `printed no usage snapshot (${ran.stdout.length} chars${ran.stdout.length >= 4_000_000 ? ', cut at the 4 MiB output limit' : ''})`
          : `exit ${ran.exitCode}: ${(ran.stderr || ran.stdout).trim().split('\n').pop() ?? ''}`
        reasons.push(`${argv.join(' ')} ${why}`)
      }
      S.usageArgv = null
      if (!S.usageMissing) $.ui.log(`nanoflow: no token usage: ${reasons.join('; ')}`, { to: 'debug' })
      S.usageMissing = true
    } finally {
      S.usageReading = null
    }
  })()
  return S.usageReading
}

/** One scan at a time; a full scan asked for meanwhile runs right after. */
const refresh = ($: $, full: boolean): Promise<void> => {
  if (S.scanning) {
    S.wantsFull ||= full
    return S.scanning
  }
  S.scanning = (async () => {
    try {
      await scan($, full)
      if (full) void refreshUsage($)
    } catch (error) {
      $.ui.log(`nanoflow: scan failed: ${String(error)}`, { to: 'debug' })
    } finally {
      S.scanning = null
      if (S.wantsFull) {
        S.wantsFull = false
        void refresh($, true)
      }
    }
  })()
  return S.scanning
}

/** Tool input that names another worktree moves THIS SESSION there (see focusFrom). */
const follow = async ($: $, input: Readonly<Record<string, unknown>>): Promise<void> => {
  const snapshot = await read($, snapshotAtom)
  if (!snapshot) return
  const text = ['file_path', 'notebook_path', 'path', 'command'].map(k => input[k]).filter(v => typeof v === 'string').join('\n')
  if (!text) return
  const win = await isWindows($)
  const focus = focusFrom(snapshot.worktrees, S.cwd, text, win)
  if (!focus || (await read($, focusAtom)) === focus) return
  await update($, focusAtom, () => focus)
  await update($, snapshotAtom, s => (s ? withFocus(s, focus, win) : s))
  await refreshStatus($)
}

// ─── actions ─────────────────────────────────────────────────────────────────────────────────────

const runAction = async ($: $, key: NfActionKey, ctx: { wt?: NfWorktree; ticket?: NfTicket; title?: string; confirmed?: boolean }): Promise<void> => {
  const action = S.config.actions[key]
  if (!action) return
  const snapshot = await read($, snapshotAtom)
  const wt = ctx.wt
  const ticket = ctx.ticket ?? wt?.ticket ?? undefined
  const vars = {
    ticket: ticket ? (ticket.key ?? ticket.number) : undefined,
    ref: ticket ? ticketLabel(ticket) : undefined,
    title: ctx.title ?? ctx.ticket?.title ?? wt?.ticket?.title,
    name: wt?.name,
    feature: wt && snapshot ? featureOf(wt.name, snapshot.mainRoot) : wt?.name,
    path: wt?.path,
    branch: wt?.branch,
    pr: wt?.pr?.number,
    mainRoot: snapshot?.mainRoot,
  }
  const label = action.label ?? key
  const subject = wt?.name ?? vars.ref ?? ''
  if (action.confirm && !ctx.confirmed) {
    const answer = await $.ui.ask(`${label} ${subject}?`, ['Yes', 'No']).catch(() => 'No')
    if (answer !== 'Yes') return
  }
  if (action.prompt !== undefined) {
    await $.prompt.submit({ text: fillTemplate(action.prompt, vars) })
    await emit($, { icon: '💬', text: `${label} ${subject}: asked Claude`, tone: 'info', important: false })
    return
  }
  if (!action.run) return
  const argv = action.run.map(part => fillTemplate(part, vars))
  const where = action.cwd === 'main' ? snapshot?.mainRoot : wt?.path
  await update($, busyAtom, () => `${label} ${subject}`)
  try {
    const { exitCode, stdout, stderr } = await runCommand($, argv, { ...(where ? { cwd: where } : {}), timeoutMs: ACTION_TIMEOUT_MS })
    const lastLine = stdout.trim().split(/\r?\n/).pop() ?? ''
    // Every run keeps its output on the activity entry, so a failure can be read in full from the pane.
    const detail = outputDetail(stdout, stderr)
    await emit($, exitCode === 0
      ? { icon: '✅', text: `${label} ${subject}${lastLine ? `: ${lastLine}` : ''}`, tone: 'success', important: true, category: 'activity', detail }
      : { icon: '❌', text: `${label} ${subject} failed: ${causeOf(`${stdout}\n${stderr}`) || `exit ${exitCode}`}`, tone: 'error', important: true, detail })
  } catch (error) {
    await emit($, { icon: '❌', text: `${label} ${subject} could not run: ${String(error)}`, tone: 'error', important: true })
  } finally {
    await update($, busyAtom, () => null)
    void refresh($, true)
  }
}

/** Tears down each done worktree with the repo's teardown action, one after another, after one question. */
const teardownAll = async ($: $, trees: readonly NfWorktree[]): Promise<void> => {
  const action = S.config.actions[ACTION.teardown]
  if (!action || trees.length === 0) return
  const names = trees.map(wt => wt.name).join(', ')
  if (action.confirm) {
    const answer = await $.ui.ask(`${action.label ?? 'Teardown'} ${trees.length} done: ${names}?`, ['Yes', 'No']).catch(() => 'No')
    if (answer !== 'Yes') return
  }
  for (const wt of trees) await runAction($, ACTION.teardown, { wt, confirmed: true })
}

/** Copy to the clipboard and say how it went. */
const copy = async ($: $, text: string, copied: string, failed: string): Promise<void> => {
  const result = await $.ui.copy({ text })
  $.ui.toast(result.isCopied ? copied : failed)
}

/**
 * Bring up the worktree's Claude session: its Windows Terminal tab when one is open, else resume its last
 * session (or start one) in a new tab. Elsewhere, the command to start one goes to the clipboard.
 */
const openSession = async ($: $, wt: NfWorktree): Promise<void> => {
  const start = `cd "${wt.path}" && claude`
  if (!(await isWindows($))) return copy($, start, `📋 Copied: ${start}`, `Start it with: ${start}`)
  const snapshot = await read($, snapshotAtom)
  const argv = powershellFile($.plugin.root, 'open-session.ps1', [
    '-Path', wt.path, '-MainRoot', snapshot?.mainRoot ?? wt.path, '-Title', worktreeTitle(wt),
    // The main checkout's branch is in too many tab titles to find its tab by.
    ...(wt.branch && !wt.isMain ? ['-Branch', wt.branch] : []),
  ])
  const { exitCode, stdout, stderr } = await runCommand($, argv, { timeoutMs: PROVIDER_TIMEOUT_MS }).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  const [outcome = '', id = ''] = stdout.trim().split(/\s+/)
  if (exitCode === 2) return copy($, start, `No Windows Terminal: 📋 copied ${start}`, `Start it with: ${start}`)
  if (exitCode !== 0) return void (await emit($, { icon: '❌', text: `Open session ${wt.name} failed`, tone: 'error', important: true, detail: outputDetail(stdout, stderr) }))
  const said: Record<string, string> = {
    tab: `🖥️ Switched to ${wt.name}'s session`,
    running: `🖥️ ${wt.name}'s session (${id.slice(0, 8)}) is open in another app`,
    resumed: `🖥️ Resumed ${wt.name}'s session in a new tab`,
    new: `🖥️ Started a session in ${wt.name}`,
  }
  $.ui.toast(said[outcome] ?? `🖥️ ${stdout.trim()}`)
}

const handlers = ($: $): PaneHandlers => ({
  setTab: (tab: NfTab) => void update($, tabAtom, () => tab),
  refresh: () => void refresh($, true),
  select: path => void update($, selectedAtom, () => path),
  toggleOutput: at => void update($, expandedAtom, open => (open === at ? null : at)),
  copyOutput: text => void copy($, text, '📋 Copied the output', 'Could not copy the output'),
  pickUp: wt => void runAction($, ACTION.pickUp, { wt }),
  startDev: wt => void runAction($, ACTION.startDev, { wt }),
  stopDev: wt => void runAction($, ACTION.stopDev, { wt }),
  teardown: wt => void runAction($, ACTION.teardown, { wt }),
  teardownDone: trees => void teardownAll($, trees),
  copyPath: wt => void copy($, wt.path, `📋 Copied ${wt.path}`, `Path: ${wt.path}`),
  openSession: wt => void openSession($, wt),
  startTask: ticket => void runAction($, ACTION.startTask, { ticket }),
  goTo: ticket => {
    void (async () => {
      const wt = (await read($, snapshotAtom))?.worktrees.find(w => w.name === ticket.worktree)
      await update($, selectedAtom, () => wt?.path ?? null)
      await update($, tabAtom, () => 'worktrees')
    })()
  },
  newTicket: title => {
    if (title.trim()) void runAction($, ACTION.newTicket, { title: title.trim() })
  },
})

const openPane = ($: $, tab?: NfTab): Promise<UiOpenResult> =>
  (async () => {
    if (tab) await update($, tabAtom, () => tab)
    return $.ui.open({ id: PANE, title: 'nanoflow' })
  })()


export const register: Register = (on, options) => {
  S.toastLevel = notifyLevelOf(options.toasts)
  S.desktopLevel = notifyLevelOf(options.desktopNotifications)
  const openPaneOnStart = options.openPaneOnStart !== false

  // ─── session ─────────────────────────────────────────────────────────────────────────────────────

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    S.cwd = e.cwd
    S.isInteractive = e.isInteractive
    await startSecrets($, e.cwd)
    await $.command.register({
      name: COMMAND,
      description: 'nanoflow by nanosite.ai: worktrees, tickets, PRs/CI, activity',
      argumentHint: '[refresh | tickets | activity | status | init]',
    })
    void (async () => {
      await loadConfig($)
      await refreshStatus($)
      await refresh($, true)
      $.clock.every(S.config.poll.localSeconds * 1000, () => void refresh($, false))
      $.clock.every(S.config.poll.githubSeconds * 1000, () => void refresh($, true))
    })()
    if (openPaneOnStart && e.isInteractive) void openPane($)
    return started
  })

  // The desktop app starts its session without a person at the prompt and joins it afterwards: open the
  // dashboard when an app attaches, unless it is already up.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (openPaneOnStart && !(await $.ui.panes()).some(pane => pane.id === PANE)) void openPane($)
    return attached
  }).catch(($, e, next) => next(e))

  on('classic.CwdChanged', async ($, e, next) => {
    const ran = await next(e)
    S.cwd = e.new_cwd
    void refresh($, false)
    return ran
  }).catch(($, e, next) => next(e))

  // Claude is waiting on the person: a permission to grant, or the prompt idle. The loudest reason to look up.
  on('classic.Notification', async ($, e, next) => {
    const ran = await next(e)
    if (!ATTENTION_TYPES.has(e.notification_type)) return ran
    // "Claude finished" already said it is the person's turn; the idle prompt a minute later adds nothing.
    if (e.notification_type === 'idle_prompt' && (await $.clock.now()) - S.turnNotifiedAt < IDLE_AFTER_TURN_MS) return ran
    pushDesktop($, 'attention', `🔔 ${await sessionLabel($)}: ${e.message}`, { important: true })
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'refresh') {
      await refresh($, true)
      await refreshUsage($)
      const snapshot = await read($, snapshotAtom)
      return { text: `nanoflow refreshed: ${snapshot?.worktrees.length ?? 0} worktrees.` }
    }
    if (arg === 'status') {
      const source = await read($, sourceAtom)
      const snapshot = await read($, snapshotAtom)
      return {
        text: [
          `config: ${source.config}`,
          `source: ${source.provider ?? 'built-in git/gh scanner'}`,
          `repo rules: ${S.config.rules.length} (+ built-ins) · actions: ${Object.keys(S.config.actions).join(', ') || 'none'}`,
          `poll: ${S.config.poll.localSeconds}s local / ${S.config.poll.githubSeconds}s GitHub`,
          `last scan: ${snapshot?.generatedAt ?? 'none'}`,
          ...(source.error ? [`warning: ${source.error}`] : []),
        ].join('\n'),
      }
    }
    if (arg === 'init') {
      const root = await checkoutRootOf($, S.cwd)
      if (!root) return { text: 'nanoflow init: not inside a git repository.' }
      const target = `${root}/.claude/nanoflow.json`
      if (await $.fs.exists(target)) return { text: `${target} already exists.` }
      const pkg = await $.fs.read(`${root}/package.json`).catch(() => null)
      const scripts = pkg ? Object.keys((JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {}) : []
      const branch = (await runCommand($, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root }).catch(() => null))
        ?.stdout.trim().replace(/^origin\//, '') || 'main'
      await $.fs.write(target, starterConfig({ hasSlotFile: await $.fs.exists(`${root}/${DEFAULT_CONFIG.slot.file}`), mainBranch: branch, scripts }))
      await loadConfig($)
      void refresh($, true)
      return { text: `Wrote ${target}: set your services' ports, rules and actions, then commit it so the team shares it.` }
    }
    const tab: NfTab = arg === 'tickets' ? 'tickets' : arg === 'activity' ? 'activity' : 'worktrees'
    const opened = await openPane($, tab)
    // Open but undrawn (a narrow terminal, or an app that places no panes): say why instead of a bare tab name.
    if (!opened.isPlaced) return { text: `nanoflow: the dashboard is open but not shown: ${opened.reason}` }
    return { text: `nanoflow: ${tab}.` }
  }).catch(() => ({ text: 'nanoflow: that failed; run `claude --debug` for the reason.' }))

  // ─── the session's own work ──────────────────────────────────────────────────────────────────────

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const rule = matchRule(e.command, S.config.rules)
    if (!rule) return next(e)
    const inBackground = 'run_in_background' in e && e.run_in_background === true
    const startText = toastFor(rule, 'start')
    S.running = inBackground ? null : rule.label
    await refreshStatus($)
    if (startText && S.toastLevel === 'all') $.ui.toast(`⏳ ${startText}`)
    if (startText) pushDesktop($, 'activity', `⏳ ${startText}`)
    const ran = await next(e)
    S.running = null
    if (ran.deny !== undefined || inBackground) {
      await refreshStatus($)
      return ran
    }
    const ok = ran.isError !== true
    if (rule.kind && CHECK_KINDS.has(rule.kind)) {
      const checks = await read($, checksAtom)
      const before: NfCheck | undefined = checks[rule.label]
      await update($, checksAtom, all => ({ ...all, [rule.label]: { label: rule.label, ok, at: Date.now() } }))
      if (before && !before.ok && ok) {
        await emit($, { icon: '🟢', text: `${rule.label} went red → green (${shortCommand(e.command, 40)})`, tone: 'success', important: true, category: 'ci' })
      }
    }
    const text = toastFor(rule, ok ? 'ok' : 'fail')
    if (text) {
      await emit($, {
        icon: ok ? '✅' : '❌',
        text: `${text} · ${shortCommand(e.command, 50)}`,
        tone: ok ? 'success' : 'error',
        important: rule.important === true || !ok,
      })
    }
    if (rule.rescan) void refresh($, rule.rescan === 'full')
    await refreshStatus($)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await update($, skillAtom, () => e.skill)
      await emit($, { icon: '📘', text: `Skill: ${e.skill}`, tone: 'info', important: false })
      await refreshStatus($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    await follow($, input)
    const browser = browserEventOf(String(e.tool), input)
    if (!browser) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const wasOpen = await read($, browserAtom)
    if (browser.kind === 'navigate') {
      await update($, browserAtom, () => true)
      if (!wasOpen) await emit($, { icon: '🌐', text: `Browser opened: ${browser.url}`, tone: 'info', important: false, href: browser.url })
    } else if (browser.kind === 'close') {
      await update($, browserAtom, () => false)
      await emit($, { icon: '🌐', text: 'Browser closed', tone: 'info', important: false })
    } else {
      await emit($, { icon: '📸', text: `Screenshot${browser.file ? ` ${browser.file}` : ''} saved`, tone: 'info', important: false })
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refreshUsage($, true)
    // The main loop's answer only: a subagent's end, an interruption or an error is no "Claude finished".
    if (e.agentId === undefined && e.reason === 'answer') pushDesktop($, 'turn', `✅ ${await sessionLabel($)}: done, your turn`)
    if ((await read($, skillAtom)) !== null) {
      await update($, skillAtom, () => null)
      await refreshStatus($)
    }
    return done
  }).catch(($, e, next) => next(e))

  // ─── the pane ────────────────────────────────────────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const source: NfSource = await read($, sourceAtom)
    const openService = S.config.services.find(s => s.open)?.name ?? null
    if (S.version === undefined) S.version = await pluginVersion($)
    const usage = await read($, usageAtom)
    return PaneView(el, {
      snapshot: await read($, snapshotAtom),
      activity: await read($, activityAtom),
      checks: await read($, checksAtom),
      tab: await read($, tabAtom),
      selected: await read($, selectedAtom),
      expanded: await read($, expandedAtom),
      busy: await read($, busyAtom),
      source,
      columns: e.props.bodyColumns,
      now: await $.clock.now(),
      can: {
        pickUp: Boolean(S.config.actions.pickUp),
        startDev: Boolean(S.config.actions.startDev),
        stopDev: Boolean(S.config.actions.stopDev),
        teardown: Boolean(S.config.actions.teardown),
        startTask: Boolean(S.config.actions.startTask),
        newTicket: Boolean(S.config.actions.newTicket),
      },
      openService,
      version: S.version,
      usage,
      // Only matched by path when there is usage to match.
      win: usage ? await isWindows($) : false,
    }, handlers($))
  })

  // ─── secrets ─────────────────────────────────────────────────────────────────────────────────────

  // Registered LAST: hooks nest first-outermost, so the secrets tool.call hook is the innermost of nanoflow's
  // and every hook above (the activity feed, toasts, the rules) sees the placeholder, never the value.
  registerSecrets(on, { allowTrackedWrites: options.secretsAllowTrackedWrites === true })
}
