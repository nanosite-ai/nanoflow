// Secrets, through the engine: filling in {{secret:NAME}}, masking what the model reads, vaulting a pasted
// secret, the system section, and the /secrets pane. Every value is a fake built at run time.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fake, FAKES } from './fakes'

const VAULT_KEY = 'secrets.vault'
const token = () => 'tok-' + fake(4)

const PANE = {
  plugin: 'nanoflow',
  component: 'Pane',
  requestId: 'nanoflow-secrets',
  props: { title: 'Secrets', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

/** The plugin's store, in memory, readable by the test (the test's own `$` has no store of its own). */
const memStore = (on: On, initial: Record<string, unknown> = {}) => {
  const mem: Record<string, unknown> = structuredClone(initial)
  on('store.get', (_$, e) => ({ value: mem[e.key] }))
  on('store.set', (_$, e) => {
    mem[e.key] = structuredClone(e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete mem[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(mem) }))
  return { vault: () => (mem[VAULT_KEY] ?? {}) as Record<string, string>, raw: mem }
}

describe('secrets: {{secret:NAME}} is filled in as the tool runs', () => {
  test('Bash and PowerShell commands, Write content and Edit strings get the value; the model wrote only the name', async ($, on) => {
    const value = token()
    const store = memStore(on, { [VAULT_KEY]: { API_TOKEN: value } })
    const ran: Record<string, unknown>[] = []
    on('tool.call', (_$, e) => {
      ran.push({ ...e })
      return { result: {} }
    })
    await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: Bearer {{secret:API_TOKEN}}" https://example.test' })
    await $.tool.call({ tool: 'PowerShell', command: '$env:T = "{{secret:API_TOKEN}}"' })
    await $.tool.call({ tool: 'Write', file_path: 'C:/tmp/.env', content: 'API_TOKEN={{secret:API_TOKEN}}\n' })
    await $.tool.call({ tool: 'Edit', file_path: 'C:/tmp/.env', old_string: 'API_TOKEN={{secret:API_TOKEN}}', new_string: 'TOKEN={{secret:API_TOKEN}}' })
    expect(ran[0]!.command).toBe(`curl -H "Authorization: Bearer ${value}" https://example.test`)
    expect(ran[1]!.command).toBe(`$env:T = "${value}"`)
    expect(ran[2]!.content).toBe(`API_TOKEN=${value}\n`)
    expect(ran[3]!.old_string).toBe(`API_TOKEN=${value}`)
    expect(ran[3]!.new_string).toBe(`TOKEN=${value}`)
  })

  test('an unknown name is refused, saying how to add it', async ($, on) => {
    memStore(on, { [VAULT_KEY]: {} })
    let didRun = false
    on('tool.call', () => {
      didRun = true
      return { result: {} }
    })
    const ran = await $.tool.call({ tool: 'Bash', command: 'echo {{secret:MISSING_KEY}}' })
    expect(didRun).toBe(false)
    expect(ran.deny ?? ran.text).toContain("secret MISSING_KEY isn't in the vault; ask the user to add it with /secrets")
  })

  test('a call with no placeholder passes untouched', async ($, on) => {
    memStore(on, {})
    const ran: string[] = []
    on('tool.call', (_$, e) => {
      if (e.tool === 'Bash') ran.push(e.command)
      return { result: {} }
    })
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect(ran).toEqual(['git status'])
  })
})

describe('secrets: what the model reads is masked', () => {
  test('a tool result (any tool, a subagent too) loses vault values and token formats', async ($, on) => {
    const value = token()
    const store = memStore(on, { [VAULT_KEY]: { API_TOKEN: value } })
    const rows = mock.session(on)
    for (const [tool, agentId] of [['Agent', undefined], ['Read', 'sub-1'], ['mcp__x__fetch', undefined]] as const) {
      await $.session.append({
        door: 'tool-result',
        origin: { kind: 'tool', tool },
        uuid: `row-${tool}`,
        ...(agentId ? { agentId } : {}),
        message: {
          type: 'user',
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `t-${tool}`, content: `token ${value}\nkey ${FAKES.github}\nDB_PASSWORD=${'pw' + fake(2) + '9'}` }],
        },
      } as never)
    }
    const kept = JSON.stringify(rows.appended().map(r => r.message.content))
    expect(kept).not.toContain(value)
    expect(kept).not.toContain(FAKES.github)
    expect(kept).toContain('{{secret:API_TOKEN}}')
    expect(kept).toContain('«redacted:github»')
    expect(kept).toContain('DB_PASSWORD=«redacted:value»')
  })

  test('a message to another session is masked', async ($, on) => {
    memStore(on, {})
    let sent = ''
    on('session.send', (_$, e) => {
      sent = e.text
      return { isDelivered: true }
    })
    await $.session.send({ to: 'peer', text: `use ${FAKES.stripe}`, origin: { kind: 'model' } } as never)
    expect(sent).toBe('use «redacted:stripe»')
  })

  test('the system prompt gains a section with the names and no value', async ($, on) => {
    const value = token()
    memStore(on, { [VAULT_KEY]: { API_TOKEN: value, DB_PASSWORD: token() } })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
    const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
    const mine = sections.find(s => s.id === 'nanoflow:secrets')!
    expect(mine.scope).toBe('session')
    expect(mine.text).toContain('Available secret names: API_TOKEN, DB_PASSWORD.')
    expect(mine.text).not.toContain(value)
    expect(sections[0]!.id).toBe('intro')
  })
})

describe('secrets: a secret typed into a prompt is vaulted', () => {
  test('stored as PASTED_<n>, replaced by its placeholder, with a toast; a known value reuses its name', async ($, on) => {
    const known = token()
    const store = memStore(on, { [VAULT_KEY]: { API_TOKEN: known, PASTED_1: 'old-' + fake(2) } })
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    let entered = ''
    on('prompt.submit', (_$, e) => {
      entered = e.text
      return { text: e.text }
    })
    await $.prompt.submit({ text: `deploy with ${FAKES.stripe} and ${known}`, wait: false, origin: { kind: 'composer' } } as never)
    expect(entered).toBe('deploy with {{secret:PASTED_2}} and {{secret:API_TOKEN}}')
    expect((store.vault()).PASTED_2).toBe(FAKES.stripe)
    expect(toasts).toContain('🔐 Stored as PASTED_2 — rename in /secrets')
  })

  test('a prompt with no secret is left as typed and stores nothing', async ($, on) => {
    const store = memStore(on, {})
    let entered = ''
    on('prompt.submit', (_$, e) => {
      entered = e.text
      return { text: e.text }
    })
    await $.prompt.submit({ text: 'fix the login bug', wait: false, origin: { kind: 'composer' } } as never)
    expect(entered).toBe('fix the login bug')
    expect(store.raw[VAULT_KEY]).toBeUndefined()
  })
})

describe('secrets: the /secrets pane', () => {
  test('add, copy, reveal for a few seconds, rename and delete, on every surface that takes input', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const store = memStore(on, {})
    const copied: string[] = []
    on('ui.copy', (_$, e) => {
      copied.push(e.text)
      return { value: { isCopied: true } }
    })
    for (const surface of ['terminal', 'desktop'] as const) {
      const value = token() + surface
      copied.length = 0
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /No secrets yet/ })).toBeDefined()

      // Add: the name, then the value and Enter. The fields are drawn anew (empty) after a save.
      const nameKey = (await ui.findAll({ type: 'Input' })).find(i => i.key?.startsWith('secret-add-name-'))!.key!
      const valueKey = (await ui.findAll({ type: 'Input' })).find(i => i.key?.startsWith('secret-add-value-'))!.key!
      await ui.input({ key: nameKey, text: 'api_token', kind: 'change' })
      await ui.input({ key: valueKey, text: value })
      expect((store.vault()).API_TOKEN).toBe(value)
      expect(await ui.find({ type: 'Text', text: /🔐 API_TOKEN/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: `${value.length} chars` })).toBeDefined()
      expect(await ui.find({ text: value })).toBeUndefined()
      expect(await ui.find({ key: valueKey })).toBeUndefined()

      // Copy puts the value on the clipboard, never on screen.
      await ui.press({ key: 'secret-copy-API_TOKEN' })
      expect(copied).toEqual([value])
      expect(await ui.find({ text: value })).toBeUndefined()

      // Reveal shows it, then it hides itself.
      await ui.press({ key: 'secret-reveal-API_TOKEN' })
      expect(await ui.find({ type: 'Text', text: value })).toBeDefined()
      await clock.advance(10_000)
      expect(await ui.find({ type: 'Text', text: value })).toBeUndefined()

      // Rename.
      await ui.press({ key: 'secret-rename-API_TOKEN' })
      await ui.input({ key: 'secret-rename-input-API_TOKEN', text: 'GITHUB_TOKEN' })
      expect(Object.keys(store.vault())).toEqual(['GITHUB_TOKEN'])

      // Delete asks first; Cancel keeps it.
      await ui.press({ key: 'secret-delete-GITHUB_TOKEN' })
      await ui.press({ key: 'secret-cancel-GITHUB_TOKEN' })
      expect((store.vault()).GITHUB_TOKEN).toBe(value)
      await ui.press({ key: 'secret-delete-GITHUB_TOKEN' })
      await ui.press({ key: 'secret-confirm-GITHUB_TOKEN' })
      expect(store.vault()).toEqual({})
      expect(await ui.find({ type: 'Text', text: /No secrets yet/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a bad name is refused with a note and nothing stored', async ($, on) => {
    const store = memStore(on, {})
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'secret-add-name-0', text: '9lives', kind: 'change' })
    await ui.input({ key: 'secret-add-value-0', text: token() })
    expect(await ui.find({ type: 'Text', text: /Type a name first/ })).toBeDefined()
    expect(store.raw[VAULT_KEY]).toBeUndefined()
    await ui.unmount()
  })

  test('Import .env stores every KEY=VALUE and shows only the names', async ($, on) => {
    const store = memStore(on, {})
    const a = token()
    const b = 'b-' + fake(3)
    // The engine hands the path on in the platform's spelling.
    const env = `# local\nAPI_TOKEN=${a}\nexport DB_PASSWORD="${b}"\n`
    on('fs.read', (_$, e) => ({ value: /proj[\\/]\.env\.local$/.test(e.path) ? env : '' }))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.input({ key: 'secret-import-0', text: 'C:/proj/.env.local' })
    expect(store.vault()).toEqual({ API_TOKEN: a, DB_PASSWORD: b })
    expect(await ui.find({ type: 'Text', text: /Imported 2 from C:\/proj\/\.env\.local: API_TOKEN, DB_PASSWORD/ })).toBeDefined()
    expect(await ui.find({ text: a })).toBeUndefined()
    expect(await ui.find({ text: b })).toBeUndefined()
    await ui.unmount()
  })

  test('/secrets opens the pane', async ($, on) => {
    const opened: string[] = []
    on('ui.open', (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    const { text } = await $.command.run({ command: 'secrets', args: '' } as never)
    expect(opened).toEqual(['nanoflow-secrets'])
    expect(text).toBe('Secrets pane opened.')
  })
})
