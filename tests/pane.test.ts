import { describe, expect, mock, test } from 'claude-code/testing'
import type { NfSnapshot, NfWorktree } from '../types'

const PANE = {
  component: 'Pane',
  requestId: 'nanoflow',
  props: { title: 'nanoflow', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const tree = (name: string, status: string | null): NfWorktree => ({
  name, path: `C:/dev/${name}`, branch: `feat/${name}`, isMain: false, isCurrent: false, slot: 1, dirty: 0, ahead: 0,
  services: [{ name: 'web', port: 5183, url: 'http://localhost:5183/', isUp: true }],
  ticket: { number: 7, title: 'dark mode', url: 'https://gh/7', state: 'OPEN', status, worktree: name },
  pr: null,
})

describe('dashboard pane', () => {
  test('draws its tabs on every surface that takes input, and switches tab', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    on('fs.read', ($, e, next) => (/\.claude-plugin[\\/]plugin\.json$/.test(e.path) ? { value: '{ "version": "9.9.9" }' } : next(e)))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'nanoflow', surface, ...PANE })
      expect(await ui.find({ key: 'tab-worktrees' })).toBeDefined()
      expect(await ui.find({ key: 'refresh' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'nanoflow v9.9.9 by nanosite.ai' })).toBeDefined()
      await ui.press({ key: 'tab-activity' })
      expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
      await ui.press({ key: 'tab-worktrees' })
      await ui.unmount()
    }
  })

  test('a failed action toasts its cause and shows its full output on demand', async ($, on) => {
    const now = Date.parse('2026-10-07T10:00:00Z')
    mock.clock(on, { now })
    mock.env(on, {})
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    // The action fails the way npm does: the cause mid-output, boilerplate last. Everything else (git, gh) fails quietly.
    on('process.run', async (_$, e) => {
      const failed = { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      if (!e.argv.includes('issue')) return { value: failed }
      return { value: {
        ...failed,
        stdout: "✖ build failed:\n'tsc' is not recognized as an internal or external command,\noperable program or batch file.",
        stderr: 'npm error code 1\nnpm error command C:\\WINDOWS\\system32\\cmd.exe /d /s /c tsc',
      } }
    })
    const ui = await $.ui.mount({ plugin: 'nanoflow', surface: 'terminal', ...PANE })
    await ui.press({ key: 'tab-tickets' })
    await ui.input({ key: 'new-ticket-input', text: 'x' })
    expect(toasts.find(t => t.startsWith('❌'))).toContain("build failed: 'tsc' is not recognized")
    await ui.press({ key: 'tab-activity' })
    expect(await ui.find({ type: 'Text', text: /operable program/ })).toBeUndefined()
    await ui.press({ key: `act-${now}-0-output` })
    expect(await ui.find({ type: 'Text', text: /operable program/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /npm error command/ })).toBeDefined()
    expect(await ui.find({ key: `act-${now}-0-copy` })).toBeDefined()
    await ui.unmount()
  })

  test('a worktree whose ticket is not under way offers ▶ Pick up, which asks Claude', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, {})
    const ready = tree('repo-7-dark-mode', 'Ready')
    const busy = tree('repo-8-search', 'In progress')
    // The pane reads its snapshot from state; hand it one instead of scanning.
    const snapshot: NfSnapshot = { version: 1, generatedAt: '2026-10-07T10:00:00Z', mainRoot: 'C:/dev/repo', current: null, worktrees: [ready, busy], board: null }
    on('state.get', ($, e, next) => (e.plugin === 'nanoflow' && e.key === 'snapshot' ? { value: { version: 1, value: snapshot } } : next(e)))
    const prompts: string[] = []
    on('prompt.submit', async (_$, e) => {
      prompts.push(e.text)
      return { drop: 'captured by the test' }
    })
    const ui = await $.ui.mount({ plugin: 'nanoflow', surface: 'terminal', ...PANE })
    await ui.press({ key: `select-${busy.path}` })
    expect(await ui.find({ key: `pick-up-${busy.path}` })).toBeUndefined()
    // A card's actions show only while it is expanded.
    expect(await ui.find({ key: `pick-up-${ready.path}` })).toBeUndefined()
    await ui.press({ key: `select-${ready.path}` })
    expect(await ui.find({ type: 'Link', label: 'web :5183' })).toBeDefined()
    await ui.press({ key: `pick-up-${ready.path}` })
    expect(prompts).toEqual(['Pick up ticket #7 (dark mode) in the worktree at C:/dev/repo-7-dark-mode: move it to In progress, then read the ticket and plan the work.'])
    await ui.unmount()
  })

  test("🖥️ session brings up another worktree's session on Windows", async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, { OS: 'Windows_NT' })
    const here = { ...tree('repo-7-dark-mode', 'In progress'), isCurrent: true }
    const other = tree('repo-8-search', 'In progress')
    const snapshot: NfSnapshot = { version: 1, generatedAt: '2026-10-07T10:00:00Z', mainRoot: 'C:/dev/repo', current: here.path, worktrees: [here, other], board: null }
    on('state.get', ($, e, next) => (e.plugin === 'nanoflow' && e.key === 'snapshot' ? { value: { version: 1, value: snapshot } } : next(e)))
    const runs: string[][] = []
    on('process.run', async (_$, e) => {
      runs.push([...e.argv])
      return { value: { exitCode: 0, stdout: 'tab #7 · feat/repo-8-search\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const ui = await $.ui.mount({ plugin: 'nanoflow', surface: 'terminal', ...PANE })
    // Not on the session's own card.
    expect(await ui.find({ key: `session-${here.path}` })).toBeUndefined()
    await ui.press({ key: `session-${other.path}` })
    const script = runs.find(argv => argv.some(a => a.endsWith('open-session.ps1')))
    expect(script).toContain('feat/repo-8-search')
    expect(script).toContain('C:/dev/repo-8-search')
    expect(toasts).toContain("🖥️ Switched to repo-8-search's session")
    await ui.unmount()
  })

  test('THIS SESSION moves to the worktree a session started in the main checkout works in', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, { OS: 'Windows_NT' })
    const porcelain = 'worktree C:/dev/repo\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/dev/repo-712-x\nHEAD 2\nbranch refs/heads/feat/712-x\n'
    on('process.run', async (_$, e) => {
      const listed = e.argv.includes('worktree')
      return { value: { exitCode: listed ? 0 : 1, stdout: listed ? porcelain : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('tool.call', () => ({ result: 'ok' }))
    on('ui.status', async () => ({ value: undefined }))
    const ui = await $.ui.mount({ plugin: 'nanoflow', surface: 'terminal', ...PANE })
    // The test's session has no cwd of its own: no card is THIS SESSION until a tool names a worktree.
    await $.command.run({ command: 'nanoflow', args: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /THIS SESSION/ })).toBeUndefined()
    await $.tool.call({ tool: 'Read', file_path: 'C:\\dev\\repo-712-x\\src\\a.ts' })
    expect(await ui.find({ type: 'Text', text: /THIS SESSION/ })).toBeDefined()
    // Its card leads the list, and its ▸ button carries no 🖥️ session button beside it.
    expect(await ui.find({ key: 'session-C:/dev/repo-712-x' })).toBeUndefined()
    expect(await ui.find({ key: 'session-C:/dev/repo' })).toBeDefined()
    await ui.unmount()
  })

  test('/nanoflow says why when the app does not show the pane', async ($, on) => {
    on('ui.open', { id: 'nanoflow' }, () => ({ value: { isPlaced: false, reason: 'no attached surface places panes' } }))
    const { text } = await $.command.run({ command: 'nanoflow', args: '' })
    expect(text).toContain('not shown: no attached surface places panes')
  })

  test('opens the dashboard when the desktop app attaches, unless it is up', async ($, on) => {
    const opened: string[] = []
    let panes: Array<{ id: string }> = []
    on('ui.panes', () => ({ value: panes }))
    on('ui.open', ($, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    on('session.attach', ($, e) => ({ clientId: e.clientId }))
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    expect(opened).toEqual(['nanoflow'])
    panes = [{ id: 'nanoflow' }]
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:2' })
    expect(opened).toEqual(['nanoflow'])
  })
})

describe('dashboard pane: teardown', () => {
  const asked: string[] = []
  /** The person answers every question Yes; records each. */
  const answerYes = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
      const questions = (e as unknown as { questions: Array<{ question: string }> }).questions
      asked.push(...questions.map(q => q.question))
      return { result: { questions, answers: Object.fromEntries(questions.map(q => [q.question, 'Yes'])) } }
    })

  const seed = (on: Parameters<Parameters<typeof test>[1]>[1], worktrees: NfWorktree[]) => {
    const snapshot: NfSnapshot = { version: 1, generatedAt: '2026-10-07T10:00:00Z', mainRoot: 'C:/dev/repo', current: null, worktrees, board: null }
    on('state.get', ($, e, next) => (e.plugin === 'nanoflow' && e.key === 'snapshot' ? { value: { version: 1, value: snapshot } } : next(e)))
    const runs: string[][] = []
    on('process.run', async (_$, e) => {
      runs.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    return runs
  }

  test('a ticket Done on the board offers 🧹 Teardown on the card title; an open PR does not', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, {})
    asked.length = 0
    answerYes(on)
    const done = tree('repo-7-dark-mode', 'Done')
    const open = { ...tree('repo-8-search', 'Done'), pr: { number: 9, url: 'https://gh/pr/9', state: 'OPEN', ci: 'pass', ciUrl: null } } as NfWorktree
    const runs = seed(on, [done, open])
    const ui = await $.ui.mount({ plugin: 'nanoflow', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: `teardown-head-${open.path}` })).toBeUndefined()
    await ui.press({ key: `teardown-head-${done.path}` })
    expect(asked).toEqual(['Teardown repo-7-dark-mode?'])
    expect(runs).toContainEqual(['git', 'worktree', 'remove', done.path])
    // Expanded, the card shows it in its actions row instead of on the title.
    await ui.press({ key: `select-${done.path}` })
    expect(await ui.find({ key: `teardown-head-${done.path}` })).toBeUndefined()
    expect(await ui.find({ key: `teardown-${done.path}` })).toBeDefined()
    await ui.unmount()
  })

  test('the fleet line tears down every done worktree after one question', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
    mock.env(on, {})
    asked.length = 0
    answerYes(on)
    const merged = { ...tree('repo-7-dark-mode', 'In review'), pr: { number: 9, url: 'https://gh/pr/9', state: 'MERGED', ci: 'pass', ciUrl: null } } as NfWorktree
    const closed = { ...tree('repo-8-search', null), ticket: { ...tree('x', null).ticket!, state: 'CLOSED' } } as NfWorktree
    const busy = tree('repo-9-busy', 'In progress')
    const runs = seed(on, [merged, closed, busy])
    const ui = await $.ui.mount({ plugin: 'nanoflow', surface: 'terminal', ...PANE })
    await ui.press({ key: 'fleet-teardown' })
    expect(asked).toEqual(['Teardown 2 done: repo-7-dark-mode, repo-8-search?'])
    const removed = runs.filter(argv => argv.slice(0, 3).join(' ') === 'git worktree remove').map(argv => argv[3])
    expect(removed).toEqual([merged.path, closed.path])
    await ui.unmount()
  })
})
