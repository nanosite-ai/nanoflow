import { describe, expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'nanoflow',
  props: { title: 'nanoflow', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

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
})
