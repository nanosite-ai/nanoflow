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
})
