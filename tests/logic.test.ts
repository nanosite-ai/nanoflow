import { describe, expect, test } from 'claude-code/testing'
import type { NfSnapshot, NfWorktree } from '../types'
import { ACTION, DEFAULT_CONFIG, fillTemplate, mergeConfig } from '../hooks/config'
import { diffSnapshots, mergeLocal } from '../hooks/diff'
import { stagesOf, statusLine } from '../hooks/progress'
import { browserEventOf, causeOf, DETAIL_LINES, matchRule, outputDetail, toastFor } from '../hooks/rules'
import { applyFlowResult, buildFlowQuery, ciRollup, parseWorktreeList, slugFromRemote, ticketNumberOf } from '../hooks/scan'
import { COLOR, folderUrl, isPickable, statusColor } from '../hooks/view'

const wt = (over: Partial<NfWorktree> = {}): NfWorktree => ({
  name: 'repo-712-x',
  path: 'C:/dev/repo-712-x',
  branch: 'feat/712-x',
  isMain: false,
  isCurrent: true,
  slot: 3,
  dirty: 0,
  ahead: 1,
  services: [{ name: 'front', port: 5203, url: 'http://localhost:5203/', isUp: false }],
  ticket: { number: 712, title: 'site offline', url: 'https://gh/712', state: 'OPEN', status: 'In progress', worktree: 'repo-712-x' },
  pr: null,
  ...over,
})

const snap = (worktrees: NfWorktree[]): NfSnapshot => ({
  version: 1,
  generatedAt: '2026-10-07T10:00:00Z',
  mainRoot: 'C:/dev/repo',
  current: worktrees[0]?.path ?? null,
  worktrees,
  board: null,
})

describe('rules', () => {
  test('repo rules win over built-ins, and playwright is not "tests"', () => {
    expect(matchRule('ns check --test', [{ match: '\\bns check\\b', kind: 'check', label: 'ns check' }])?.label).toBe('ns check')
    expect(matchRule('npx playwright test e2e/x.spec.ts', [])?.label).toBe('e2e')
    expect(matchRule('npm run test:integration', [])?.label).toBe('tests')
    expect(matchRule('cd apps/server && npm run tsc && npm run lint', [])?.label).toBe('typecheck')
    expect(matchRule('ls -la', [])).toBe(null)
  })

  test('the nanoflow CLI gets toasts with no config, under either name', () => {
    expect(matchRule('nf task start 12', [])?.label).toBe('kickoff')
    expect(matchRule('cd ../x && nanoflow pr create --shots a.png', [])?.label).toBe('PR')
    expect(matchRule('nf check typecheck', [])?.kind).toBe('check')
    expect(matchRule('echo conf ci', [])).toBe(null)
  })

  test('toast text per phase', () => {
    expect(toastFor({ match: 'x', toast: 'Shipped' }, 'ok')).toBe('Shipped')
    expect(toastFor({ match: 'x', toast: 'Shipped' }, 'start')).toBe(null)
    expect(toastFor({ match: 'x', toast: { fail: 'nope' } }, 'fail')).toBe('nope')
  })

  test('playwright MCP calls are browser moments, others are not', () => {
    expect(browserEventOf('mcp__playwright__browser_navigate', { url: 'http://localhost:5243' })).toEqual({ kind: 'navigate', url: 'http://localhost:5243' })
    expect(browserEventOf('mcp__playwright-social__browser_close', {})).toEqual({ kind: 'close' })
    expect(browserEventOf('mcp__other__browser_navigate', { url: 'x' })).toBe(null)
  })
})

describe('failed command output', () => {
  // `ns up --bg` in a worktree whose npm install never finished.
  const NPM_FAIL = [
    '702-promo-name-only (slot 6)  front http://localhost:5233',
    '▶ building @nanosite/ecommerce-sdk',
    '✖ build of @nanosite/ecommerce-sdk failed:',
    '> tsc -p tsconfig.build.json',
    "'tsc' is not recognized as an internal or external command,",
    'operable program or batch file.',
    'npm error Lifecycle script `build` failed with error:',
    'npm error code 1',
    'npm error path C:\\x\\packages\\ecommerce-sdk',
    'npm error command failed',
    'npm error command C:\\WINDOWS\\system32\\cmd.exe /d /s /c tsc -p tsconfig.build.json',
  ].join('\r\n')

  test('names the headline and its cause, not npm boilerplate', () => {
    expect(causeOf(NPM_FAIL)).toBe("build of @nanosite/ecommerce-sdk failed: 'tsc' is not recognized as an internal or external command")
  })

  test('a busy port, a bare headline, plain output', () => {
    expect(causeOf('starting\nError: listen EADDRINUSE: address already in use :::5173\n    at Server.listen')).toBe('listen EADDRINUSE: address already in use :::5173')
    expect(causeOf('\u001b[31m✖ checks failed\u001b[0m\ndone')).toBe('checks failed')
    expect(causeOf('one\ntwo\n')).toBe('two')
    expect(causeOf('')).toBe('')
  })

  test('keeps stdout then stderr, without colors, capped', () => {
    expect(outputDetail('out\n', '\u001b[31merr\u001b[0m')).toBe('out\nerr')
    const long = outputDetail(Array.from({ length: DETAIL_LINES + 5 }, (_, i) => `l${i}`).join('\n'), '')
    expect(long.split('\n')).toHaveLength(DETAIL_LINES + 1)
    expect(long.startsWith('… 5 earlier lines')).toBe(true)
  })
})

describe('config', () => {
  test('merges over defaults and drops bad fields', () => {
    const c = mergeConfig({
      provider: { snapshot: ['ns', 'flow', '--json'] },
      services: [{ name: 'front', base: 5173, step: 10 }, { name: 'bad' }],
      rules: [{ match: '(' }, { match: 'ok' }],
      poll: { localSeconds: 1 },
    })
    expect(c.provider?.snapshot).toEqual(['ns', 'flow', '--json'])
    expect(c.services.length).toBe(1)
    expect(c.rules.length).toBe(1)
    expect(c.poll.localSeconds).toBe(DEFAULT_CONFIG.poll.localSeconds)
  })

  test('actions override, and null removes one', () => {
    const c = mergeConfig({ actions: { pickUp: { run: ['ns', 'board', 'set', '{ticket}', 'in-progress'] }, startTask: null, startDev: { run: ['x'] } } })
    expect(c.actions[ACTION.pickUp]?.run).toEqual(['ns', 'board', 'set', '{ticket}', 'in-progress'])
    expect(c.actions[ACTION.startTask]).toBe(undefined)
    expect(Object.keys(c.actions).includes('startDev')).toBe(false)
  })

  test('templates', () => {
    expect(fillTemplate('ns task start {ticket} "{title}" {missing}', { ticket: 7, title: 'x' })).toBe('ns task start 7 "x" ')
  })
})

describe('scan helpers', () => {
  test('worktree list + ticket numbers', () => {
    const trees = parseWorktreeList('worktree C:/dev/repo\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/dev/repo-712-x\nHEAD 2\nbranch refs/heads/feat/712-x\n')
    expect(trees).toEqual([{ path: 'C:/dev/repo', branch: 'main' }, { path: 'C:/dev/repo-712-x', branch: 'feat/712-x' }])
    expect(ticketNumberOf(DEFAULT_CONFIG.ticket.branchPattern, 'feat/712-x', '')).toBe(712)
    expect(ticketNumberOf(DEFAULT_CONFIG.ticket.branchPattern, 'feat/ads', 'repo-ads')).toBe(null)
  })

  test('CI rollup', () => {
    expect(ciRollup([{ status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u' }])).toEqual({ ci: 'fail', ciUrl: 'u' })
    expect(ciRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]).ci).toBe('pass')
    expect(ciRollup([]).ci).toBe('none')
  })

  test('folder links', () => {
    expect(folderUrl('C:/Users/A B/repo')).toBe('file:///C:/Users/A%20B/repo')
    expect(folderUrl('/home/a/repo')).toBe('file:///home/a/repo')
  })

  test('board columns get their colors', () => {
    expect(statusColor('In progress')).toBe(COLOR.wait)
    expect(statusColor('In review')).toBe(COLOR.merged)
    expect(statusColor('Ready')).toBe(COLOR.info)
    expect(statusColor(null)).toBe(COLOR.muted)
  })

  test('a ticket is up for pickup until it is under way', () => {
    const ticket = (status: string | null) => ({ number: 7, title: 'x', url: 'u', state: 'OPEN', status, worktree: 'repo-7-x' })
    expect(isPickable(wt({ ticket: ticket('Ready') }))).toBe(true)
    expect(isPickable(wt({ ticket: ticket(null) }))).toBe(true)
    expect(isPickable(wt({ ticket: ticket('In progress') }))).toBe(false)
    expect(isPickable(wt({ ticket: ticket('In review') }))).toBe(false)
    expect(isPickable(wt({ ticket: ticket('Done') }))).toBe(false)
    expect(isPickable(wt({ ticket: ticket('Ready'), pr: { number: 8, url: 'u', state: 'OPEN', ci: 'none', ciUrl: null } }))).toBe(false)
    expect(isPickable(wt({ ticket: { ...ticket('Ready'), state: 'CLOSED' } }))).toBe(false)
    expect(isPickable(wt({ ticket: null }))).toBe(false)
    expect(isPickable(wt({ ticket: ticket('Ready'), isMain: true }))).toBe(false)
  })
})

describe('github in one query', () => {
  test('aliases each ticket and branch, and folds the answer back', () => {
    const trees = [wt({ isMain: true, branch: 'main', ticket: null }), wt()]
    const q = buildFlowQuery(trees)
    expect(q.includes('t1: issue(number: 712)')).toBe(true)
    expect(q.includes('p1: pullRequests(headRefName: "feat/712-x"')).toBe(true)
    expect(q.includes('p0:')).toBe(false)
    const config = mergeConfig({ github: { board: { owner: 'acme', number: 1 } } })
    const status = (name: string) => ({ nodes: [{ project: { number: 1, owner: { login: 'acme' } }, fieldValueByName: { name } }] })
    const board = applyFlowResult(config, trees, {
      open: { nodes: [
        { number: 712, title: 'site offline', url: 'u712', state: 'OPEN', projectItems: status('In progress') },
        { number: 9, title: 'later', url: 'u9', state: 'OPEN', projectItems: status('Backlog') },
      ] },
      t1: { number: 712, title: 'site offline', url: 'u712', state: 'OPEN', projectItems: status('In progress') },
      p1: { nodes: [{ number: 713, url: 'pr', state: 'OPEN', commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'run' }] } } } }] } }] },
    })
    expect(trees[1]?.pr).toEqual({ number: 713, url: 'pr', state: 'OPEN', ci: 'fail', ciUrl: 'run' })
    expect(trees[1]?.ticket?.status).toBe('In progress')
    expect(board.map(t => [t.number, t.worktree])).toEqual([[712, 'repo-712-x']])
  })

  test('repo slug from the origin remote', () => {
    expect(slugFromRemote('git@github.com:acme/app.git')).toBe('acme/app')
    expect(slugFromRemote('https://github.com/acme/app')).toBe('acme/app')
    expect(slugFromRemote('https://gitlab.com/acme/app')).toBe(null)
  })
})

describe('diff', () => {
  test('the first snapshot is a baseline', () => {
    expect(diffSnapshots(null, snap([wt()]), false)).toEqual([])
  })

  test('service up, PR merged → teardown nudge (+ browser reminder)', () => {
    const before = snap([wt({ pr: { number: 713, url: 'pr', state: 'OPEN', ci: 'pending', ciUrl: null } })])
    const after = snap([wt({
      services: [{ name: 'front', port: 5203, url: 'http://localhost:5203/', isUp: true }],
      pr: { number: 713, url: 'pr', state: 'MERGED', ci: 'pass', ciUrl: null },
    })])
    const texts = diffSnapshots(before, after, true).map(e => e.text)
    expect(texts.some(t => t.includes('front is up'))).toBe(true)
    expect(texts.some(t => t.startsWith('PR #713 merged'))).toBe(true)
    expect(texts.some(t => t.includes('Tear down repo-712-x') && t.includes('close the browser'))).toBe(true)
    expect(texts.some(t => t.includes('CI green'))).toBe(true)
  })

  test('worktrees appearing and leaving', () => {
    const texts = diffSnapshots(snap([wt()]), snap([wt({ path: 'C:/dev/repo-9-y', name: 'repo-9-y' })]), false).map(e => e.text)
    expect(texts).toEqual(['Worktree repo-9-y created (slot 3)', 'Worktree repo-712-x removed'])
  })

  test('a local poll keeps the PR and title from the last full one', () => {
    const full = snap([wt({ pr: { number: 713, url: 'pr', state: 'OPEN', ci: 'pass', ciUrl: null } })])
    const local = snap([wt({ ticket: { number: 712, title: null, url: '', state: null, status: null, worktree: 'repo-712-x' } })])
    const merged = mergeLocal(full, local)
    expect(merged.worktrees[0]?.pr?.number).toBe(713)
    expect(merged.worktrees[0]?.ticket?.title).toBe('site offline')
    expect(diffSnapshots(full, merged, false)).toEqual([])
  })
})

describe('progress', () => {
  test('stages and the status line', () => {
    const w = wt({ pr: { number: 713, url: 'pr', state: 'OPEN', ci: 'fail', ciUrl: null } })
    expect(stagesOf(w, { tests: { label: 'tests', ok: true, at: 1 } }).map(s => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'fail', 'todo'])
    expect(statusLine({ snapshot: snap([w]), checks: {}, running: 'tests', skill: null }))
      .toBe('#712 site offline │ ✓ticket ✓branch ✓code ○checks ✓PR #713 ✗CI ○merged │ 1 worktree │ ⏳ tests')
    expect(statusLine({ snapshot: null, checks: {}, running: null, skill: null })).toBe('nanoflow · scanning…')
  })
})
