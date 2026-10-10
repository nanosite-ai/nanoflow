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
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'nanoflow', surface, ...PANE })
      expect(await ui.find({ key: 'tab-worktrees' })).toBeDefined()
      expect(await ui.find({ key: 'refresh' })).toBeDefined()
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
})
