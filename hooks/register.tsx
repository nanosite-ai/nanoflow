// nanoflow: the dev workflow, live. A dashboard pane, a progress status line and toasts, fed by the repo's
// provider command (e.g. `ns flow --json`) or the built-in git/gh scanner, plus the session's own tool calls.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { NfActivity, NfCheck, NfService, NfSnapshot, NfSource, NfTab, NfTicket, NfWorktree } from '../types'
import { ACTION, DEFAULT_CONFIG, fillTemplate, mergeConfig, starterConfig, type NfActionKey, type NfConfig } from './config'
import { diffSnapshots, mergeLocal, type NfEvent } from './diff'
import { statusLine } from './progress'
import { browserEventOf, CHECK_KINDS, matchRule, shortCommand, toastFor } from './rules'
import {
  applyFlowResult, baseName, buildFlowQuery, isInside, isSnapshot, normalizePath, parseJson, parseWorktreeList, quoteForCmd, samePath, serviceUrl,
  featureOf, slugFromRemote, ticketNumberOf, ticketUrl, type GitWorktree, type GqlRepo,
} from './scan'
import { PaneView, type PaneHandlers } from './view'

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
const busyAtom = atom({ plugin: 'nanoflow', key: 'busy' } as const, null)
const sourceAtom = atom({ plugin: 'nanoflow', key: 'source' } as const, { config: 'defaults', provider: null, error: null })

/** Module state: what the hooks share. Reset by a reload; the drawn data lives in $.state. */
const S = {
  config: DEFAULT_CONFIG as NfConfig,
  cwd: '',
  running: null as string | null,
  scanning: null as Promise<void> | null,
  wantsFull: false,
  providerWarned: false,
  toastLevel: 'all',
}

// ─── host I/O: git, gh, the provider, liveness probes ($ cannot cross an import, so it all lives here) ──

const PROVIDER_TIMEOUT_MS = 60_000
const PROBE_TIMEOUT_MS = 1500

let isWindowsCache: boolean | undefined
const isWindows = async ($: $): Promise<boolean> => {
  isWindowsCache ??= (await $.env.get('OS')) === 'Windows_NT'
  return isWindowsCache
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
  const n = ticketNumberOf(S.config.ticket.branchPattern, wt.branch, name)
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
    ticket: n === null ? null : { number: n, title: null, url: ticketUrl(S.config, n, null), state: null, status: null, worktree: name },
    pr: null,
  }
}

/** Titles, PRs + CI and the open tickets for every worktree, in one GraphQL call. */
const githubFill = async ($: $, mainRoot: string, trees: NfWorktree[]): Promise<NfTicket[] | null> => {
  const slug = S.config.github.repo ?? slugFromRemote((await runText($, ['git', 'remote', 'get-url', 'origin'], mainRoot)) ?? '')
  if (!slug) return null
  const [owner, name] = slug.split('/')
  const out = await runText($, ['gh', 'api', 'graphql', '-f', `query=${buildFlowQuery(trees)}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '--jq', '.data.repository'], mainRoot)
  const data = parseJson<GqlRepo>(out)
  return data ? applyFlowResult(S.config, trees, data) : null
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
  const board = full && S.config.ticket.github ? await githubFill($, mainRoot, trees) : null
  return {
    version: 1,
    generatedAt: new Date(await $.clock.now()).toISOString(),
    mainRoot,
    current: containing?.path ?? null,
    worktrees: trees,
    board,
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
  }))
}

const emit = async ($: $, event: NfEvent): Promise<void> => {
  const entry: NfActivity = { at: await $.clock.now(), icon: event.icon, text: event.text, tone: event.tone, ...(event.href ? { href: event.href } : {}) }
  await update($, activityAtom, list => [...list, entry].slice(-ACTIVITY_LIMIT))
  const wanted = S.toastLevel === 'all' || (S.toastLevel === 'important' && (event.important || event.tone === 'error'))
  if (wanted) $.ui.toast(`${event.icon} ${event.text}`)
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
        await emit($, { icon: '⚠️', text: `nanoflow provider failed (${reason}); falling back to git/gh`, tone: 'warning', important: true })
      }
    }
  }
  return builtinSnapshot($, full)
}

const scan = async ($: $, full: boolean): Promise<void> => {
  const prev = await read($, snapshotAtom)
  const fresh = await snapshotFor($, full)
  const next = full ? fresh : mergeLocal(prev, fresh)
  const events = diffSnapshots(prev, next, await read($, browserAtom))
  await update($, snapshotAtom, () => next)
  for (const event of events) await emit($, event)
  await refreshStatus($)
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

// ─── actions ─────────────────────────────────────────────────────────────────────────────────────

const runAction = async ($: $, key: NfActionKey, ctx: { wt?: NfWorktree; ticket?: NfTicket; title?: string }): Promise<void> => {
  const action = S.config.actions[key]
  if (!action) return
  const snapshot = await read($, snapshotAtom)
  const wt = ctx.wt
  const vars = {
    ticket: ctx.ticket?.number ?? wt?.ticket?.number,
    title: ctx.title ?? ctx.ticket?.title ?? wt?.ticket?.title,
    name: wt?.name,
    feature: wt && snapshot ? featureOf(wt.name, snapshot.mainRoot) : wt?.name,
    path: wt?.path,
    branch: wt?.branch,
    pr: wt?.pr?.number,
    mainRoot: snapshot?.mainRoot,
  }
  const label = action.label ?? key
  const subject = wt?.name ?? (vars.ticket !== undefined ? `#${vars.ticket}` : '')
  if (action.confirm) {
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
    const lastLine = (exitCode === 0 ? stdout : stderr || stdout).trim().split(/\r?\n/).pop() ?? ''
    await emit($, exitCode === 0
      ? { icon: '✅', text: `${label} ${subject}${lastLine ? `: ${lastLine}` : ''}`, tone: 'success', important: true }
      : { icon: '❌', text: `${label} ${subject} failed: ${lastLine}`, tone: 'error', important: true })
  } catch (error) {
    await emit($, { icon: '❌', text: `${label} ${subject} could not run: ${String(error)}`, tone: 'error', important: true })
  } finally {
    await update($, busyAtom, () => null)
    void refresh($, true)
  }
}

const handlers = ($: $): PaneHandlers => ({
  setTab: (tab: NfTab) => void update($, tabAtom, () => tab),
  refresh: () => void refresh($, true),
  select: path => void update($, selectedAtom, () => path),
  startDev: wt => void runAction($, ACTION.startDev, { wt }),
  stopDev: wt => void runAction($, ACTION.stopDev, { wt }),
  teardown: wt => void runAction($, ACTION.teardown, { wt }),
  copyPath: wt => {
    void (async () => {
      const copied = await $.ui.copy({ text: wt.path })
      $.ui.toast(copied.isCopied ? `📋 Copied ${wt.path}` : `Path: ${wt.path}`)
    })()
  },
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

const openPane = ($: $, tab?: NfTab): Promise<unknown> =>
  (async () => {
    if (tab) await update($, tabAtom, () => tab)
    return $.ui.open({ id: PANE, title: 'nanoflow' })
  })()


export const register: Register = (on, options) => {
  S.toastLevel = typeof options.toasts === 'string' ? options.toasts : 'all'
  const openPaneOnStart = options.openPaneOnStart !== false

  // ─── session ─────────────────────────────────────────────────────────────────────────────────────

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    S.cwd = e.cwd
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

  on('classic.CwdChanged', async ($, e, next) => {
    const ran = await next(e)
    S.cwd = e.new_cwd
    void refresh($, false)
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'refresh') {
      await refresh($, true)
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
    await openPane($, tab)
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
        await emit($, { icon: '🟢', text: `${rule.label} went red → green (${shortCommand(e.command, 40)})`, tone: 'success', important: true })
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
    const browser = browserEventOf(String(e.tool), e as unknown as Record<string, unknown>)
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
    return PaneView(el, {
      snapshot: await read($, snapshotAtom),
      activity: await read($, activityAtom),
      checks: await read($, checksAtom),
      tab: await read($, tabAtom),
      selected: await read($, selectedAtom),
      busy: await read($, busyAtom),
      source,
      columns: e.props.bodyColumns,
      now: await $.clock.now(),
      can: {
        startDev: Boolean(S.config.actions.startDev),
        stopDev: Boolean(S.config.actions.stopDev),
        teardown: Boolean(S.config.actions.teardown),
        startTask: Boolean(S.config.actions.startTask),
        newTicket: Boolean(S.config.actions.newTicket),
      },
      openService,
    }, handlers($))
  })
}
