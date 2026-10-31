// Secrets: values the person keeps in nanoflow's vault and the model never reads. The model writes
// {{secret:NAME}}; tool.call fills it in as the tool runs, only for the commands and hosts the person allowed
// for that secret, quoted for the shell, and into git-ignored files only. What the model reads is masked on
// its way into the conversation (session.append), as are injected attachments and outgoing messages; a
// token pasted into a prompt is vaulted as PASTED_<n> first. A guard against accidents, not against a
// hostile agent: see docs/secrets.md. Wired from ../register, LAST, so its tool.call hook is the innermost
// of nanoflow's and nanoflow's own feed sees the placeholder.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { NfSecret, NfSecretScope, NfTone } from '../../types'
import {
  allValues, checkName, disallowedUse, effectiveEntries, firstProgram, isExampleFile, nextPastedName, parseAllow, parseEnv,
  parseVaultStore, placeholderNames, REDACTED_MARK, redact, redactContent, SECTION_ID, sectionText, substitute, valuesOf,
  VAULT_KEY, type Entry, type Shell, type VaultStore,
} from './redact'
import { SecretsView, type SecretsHandlers } from './view'

type $ = EngineInterface

export const SECRETS_PANE = 'nanoflow-secrets'
export const SECRETS_COMMAND = 'secrets'
export const REVEAL_MS = 10_000

/** The tools whose input may carry a placeholder, the fields filled in, and the shell that reads them. */
export const FILLED: Readonly<Record<string, { fields: readonly string[]; shell: Shell }>> = {
  Bash: { fields: ['command'], shell: 'bash' },
  PowerShell: { fields: ['command'], shell: 'powershell' },
  Write: { fields: ['content'], shell: 'raw' },
  Edit: { fields: ['old_string', 'new_string'], shell: 'raw' },
}

/** The fields of a file write that must never carry a «redacted:…» mark. */
const WRITTEN: Readonly<Record<string, readonly string[]>> = { Write: ['content'], Edit: ['new_string'], NotebookEdit: ['new_source'] }

const listAtom = atom({ plugin: 'nanoflow', key: 'secrets' } as const, [])
const projectAtom = atom({ plugin: 'nanoflow', key: 'secretsProject' } as const, { root: null, cwd: '' })
const revealAtom = atom({ plugin: 'nanoflow', key: 'secretsReveal' } as const, null)
const confirmAtom = atom({ plugin: 'nanoflow', key: 'secretsConfirm' } as const, null)
const renameAtom = atom({ plugin: 'nanoflow', key: 'secretsRename' } as const, null)
const noteAtom = atom({ plugin: 'nanoflow', key: 'secretsNote' } as const, null)
const formAtom = atom({ plugin: 'nanoflow', key: 'secretsForm' } as const, 0)
const draftAtom = atom({ plugin: 'nanoflow', key: 'secretsDraft' } as const, '')
const addScopeAtom = atom({ plugin: 'nanoflow', key: 'secretsAddScope' } as const, 'project')
const pastedAtom = atom({ plugin: 'nanoflow', key: 'secretsPasted' } as const, null)

/**
 * Module memory, reset by a reload: the last vault values read (so a hook that overran still masks them),
 * the tool calls that read an example file (their assignment lines are left alone), and the write queue.
 */
const M = {
  lastValues: [] as Array<[string, string]>,
  exampleIds: new Set<string>(),
  writing: Promise.resolve() as Promise<unknown>,
  /** The user's setting: every secret may be written into tracked files. */
  allowTrackedWrites: false,
}

/** The vault's size, for the status line (nanoflow redraws it on every poll). */
export async function secretCount($: $): Promise<number> {
  return (await read($, listAtom)).length
}

// ─── the vault ───────────────────────────────────────────────────────────────────────────────────

const idOf = (scope: NfSecretScope, name: string): string => `${scope === 'project' ? 'p' : 'g'}-${name}`
const fromId = (id: string): { scope: NfSecretScope; name: string } => ({ scope: id.startsWith('p-') ? 'project' : 'global', name: id.slice(2) })

async function projectRoot($: $): Promise<string | null> {
  return (await read($, projectAtom)).root
}

async function readStore($: $): Promise<VaultStore> {
  const store = parseVaultStore(await $.store.get(VAULT_KEY))
  M.lastValues = allValues(store, await projectRoot($))
  return store
}

/** The store for masking and filling in: never throws, so a store that cannot be read still leaves the patterns. */
async function storeOrEmpty($: $): Promise<VaultStore> {
  try {
    return await readStore($)
  } catch {
    return { global: {}, projects: {} }
  }
}

/** The values to mask with: all of the store's, or (when it cannot be read) the ones last read. */
async function maskValues($: $): Promise<Array<[string, string]>> {
  try {
    return allValues(await readStore($), await projectRoot($))
  } catch {
    return M.lastValues
  }
}

async function publish($: $, store: VaultStore): Promise<void> {
  const root = await projectRoot($)
  const row = (scope: NfSecretScope) => ([name, e]: [string, Entry]): NfSecret => ({
    id: idOf(scope, name), name, scope, length: e.value.length, allow: e.allow, allowTracked: e.allowTracked === true,
  })
  const list = [
    ...(root ? Object.entries(store.projects[root] ?? {}).sort().map(row('project')) : []),
    ...Object.entries(store.global).sort().map(row('global')),
  ]
  await update($, listAtom, () => list)
}

/** The entries of one scope, created on demand. */
const scopeOf = (store: VaultStore, scope: NfSecretScope, root: string | null): Record<string, Entry> => {
  if (scope === 'global' || !root) return store.global
  store.projects[root] ??= {}
  return store.projects[root]
}

/**
 * Changes the vault: one change at a time in this session, each re-reading the store right before it writes
 * (another session may have written meanwhile). The one place the vault is written.
 */
async function changeStore($: $, change: (store: VaultStore, root: string | null) => void): Promise<VaultStore> {
  const run = M.writing.then(async () => {
    const store = await readStore($)
    const root = await projectRoot($)
    change(store, root)
    await $.store.set(VAULT_KEY, store)
    M.lastValues = allValues(store, root)
    await publish($, store)
    return store
  })
  M.writing = run.catch(() => undefined)
  return run
}

function note($: $, text: string, tone: NfTone = 'info') {
  return update($, noteAtom, () => ({ text, tone }))
}

/** Masks the secrets in a person's text; a high-confidence token the vault lacks is stored as PASTED_<n>. */
async function vaultPasted($: $, text: string): Promise<{ text: string; stored: string[] } | null> {
  const values = await maskValues($)
  const store = await storeOrEmpty($)
  const root = await projectRoot($)
  const byValue = new Map(values.map(([name, value]) => [value, name]))
  const taken = Object.keys(effectiveEntries(store, root))
  const added: Record<string, string> = {}
  const result = redact(text, values, {
    onUnknown: value => {
      const known = byValue.get(value)
      if (known) return known
      const name = nextPastedName([...taken, ...Object.keys(added)])
      added[name] = value
      byValue.set(value, name)
      return name
    },
  })
  if (result.hits.length === 0) return null
  const stored = Object.keys(added)
  if (stored.length) {
    const scope: NfSecretScope = root ? 'project' : 'global'
    await changeStore($, (s, r) => {
      const entries = scopeOf(s, scope, r)
      for (const [name, value] of Object.entries(added)) entries[name] = { value, allow: [] }
    })
    await update($, pastedAtom, () => ({ names: stored, scope }))
    $.ui.toast(`🔐 Stored as ${stored.join(', ')} — rename, allow or undo in /secrets`)
  }
  return { text: result.text, stored }
}

async function undoPasted($: $): Promise<string> {
  const pasted = await read($, pastedAtom)
  if (!pasted) return 'Nothing to undo.'
  await changeStore($, (s, r) => {
    const entries = scopeOf(s, pasted.scope, r)
    for (const name of pasted.names) delete entries[name]
  })
  await update($, pastedAtom, () => null)
  const text = `↩ Removed ${pasted.names.join(', ')} from the vault.`
  await note($, text, 'success')
  return text
}

async function resolvePath($: $, raw: string): Promise<string> {
  const path = raw.trim().replace(/^["']|["']$/g, '')
  if (path.startsWith('~')) {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    return `${home.replace(/\\/g, '/')}${path.slice(1)}`
  }
  const { cwd } = await read($, projectAtom)
  if (/^([A-Za-z]:)?[\\/]/.test(path) || !cwd) return path
  return `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${path}`
}

const dirOf = (path: string): string => path.replace(/\\/g, '/').replace(/\/[^/]*$/, '') || '/'

/** Whether git ignores `path` (or it is in no repository, so nothing commits it). */
async function isIgnored($: $, path: string): Promise<boolean> {
  try {
    const { exitCode, stderr } = await $.process.run(['git', 'check-ignore', '-q', '--no-index', path], { cwd: dirOf(path), timeoutMs: 10_000 })
    if (exitCode === 0) return true
    return exitCode === 128 && /not a git repository/i.test(stderr)
  } catch {
    return false
  }
}

const handlers = ($: $): SecretsHandlers => ({
  copy: (id, surface) => {
    void (async () => {
      const { scope, name } = fromId(id)
      const value = scopeOf(await readStore($), scope, await projectRoot($))[name]?.value
      if (value === undefined) return void (await note($, `${name} is no longer in the vault.`, 'error'))
      const copied = await $.ui.copy({ text: value, surface: surface as never })
      await note($, copied.isCopied ? `📋 Copied ${name}` : `Could not copy ${name} (${copied.reason ?? 'no clipboard'})`, copied.isCopied ? 'success' : 'error')
    })()
  },
  reveal: id => {
    void (async () => {
      const at = await $.clock.now()
      await update($, revealAtom, () => ({ id, at }))
      $.clock.after(REVEAL_MS, () => void update($, revealAtom, shown => (shown?.id === id && shown.at === at ? null : shown)))
    })()
  },
  hide: () => void update($, revealAtom, () => null),
  askDelete: id => void update($, confirmAtom, () => id),
  cancel: () => void update($, confirmAtom, () => null),
  confirmDelete: id => {
    void (async () => {
      const { scope, name } = fromId(id)
      await changeStore($, (s, r) => {
        delete scopeOf(s, scope, r)[name]
      })
      await update($, confirmAtom, () => null)
      await update($, revealAtom, shown => (shown?.id === id ? null : shown))
      await note($, `🗑 Deleted ${name}`, 'success')
    })()
  },
  startRename: id => void update($, renameAtom, current => (current === id ? null : id)),
  rename: (id, to) => {
    void (async () => {
      const checked = checkName(to)
      if ('error' in checked) return void (await note($, checked.error, 'error'))
      const { scope, name: from } = fromId(id)
      const name = checked.name
      if (name !== from && scopeOf(await readStore($), scope, await projectRoot($))[name] !== undefined) return void (await note($, `${name} already exists.`, 'error'))
      await changeStore($, (s, r) => {
        const entries = scopeOf(s, scope, r)
        const entry = entries[from]
        if (!entry) return
        delete entries[from]
        entries[name] = entry
      })
      await update($, renameAtom, () => null)
      await note($, `✏️ Renamed ${from} to ${name}`, 'success')
    })()
  },
  allow: (id, text) => {
    void (async () => {
      const items = parseAllow(text)
      if (items.length === 0) return
      const { scope, name } = fromId(id)
      await changeStore($, (s, r) => {
        const entry = scopeOf(s, scope, r)[name]
        if (entry) entry.allow = [...new Set([...entry.allow, ...items])]
      })
      await update($, formAtom, n => n + 1)
      await note($, `✅ ${name} may now be used with ${items.join(', ')}`, 'success')
    })()
  },
  unallow: (id, item) => {
    void (async () => {
      const { scope, name } = fromId(id)
      await changeStore($, (s, r) => {
        const entry = scopeOf(s, scope, r)[name]
        if (entry) entry.allow = entry.allow.filter(a => a !== item)
      })
    })()
  },
  draftName: raw => {
    void (async () => {
      const checked = checkName(raw)
      // A value pasted into the Name field is never kept, not even as a draft.
      if ('error' in checked && checked.error.startsWith('That looks like a secret value')) {
        await update($, draftAtom, () => '')
        return void (await note($, checked.error, 'error'))
      }
      await update($, draftAtom, () => raw)
    })()
  },
  add: value => {
    void (async () => {
      const checked = checkName(await read($, draftAtom))
      if ('error' in checked) return void (await note($, `Type a name first. ${checked.error}`, 'error'))
      if (!value) return void (await note($, 'The value is empty.', 'error'))
      const scope = await read($, addScopeAtom)
      await changeStore($, (s, r) => {
        const entries = scopeOf(s, scope, r)
        entries[checked.name] = { value, allow: entries[checked.name]?.allow ?? [] }
      })
      await update($, draftAtom, () => '')
      await update($, formAtom, n => n + 1)
      await note($, `🔐 Saved ${checked.name}. Allow the commands or hosts it is for, below its name.`, 'success')
    })()
  },
  setAddScope: scope => void update($, addScopeAtom, () => scope),
  importEnv: raw => {
    void (async () => {
      if (!raw.trim()) return
      const path = await resolvePath($, raw)
      const text = await $.fs.read(path).catch(() => null)
      if (text === null) return void (await note($, `Could not read ${path}.`, 'error'))
      const entries = parseEnv(text)
      if (entries.length === 0) return void (await note($, `No KEY=VALUE lines in ${path}.`, 'warning'))
      const scope = await read($, addScopeAtom)
      await changeStore($, (s, r) => {
        const target = scopeOf(s, scope, r)
        for (const e of entries) target[e.name] = { value: e.value, allow: target[e.name]?.allow ?? [] }
      })
      await update($, formAtom, n => n + 1)
      await note($, `📥 Imported ${entries.length} from ${path}: ${entries.map(e => e.name).join(', ')}`, 'success')
    })()
  },
  undoPasted: () => void undoPasted($),
  toggleTracked: id => {
    void (async () => {
      const { scope, name } = fromId(id)
      let now = false
      await changeStore($, (s, r) => {
        const entry = scopeOf(s, scope, r)[name]
        if (!entry) return
        now = entry.allowTracked !== true
        if (now) entry.allowTracked = true
        else delete entry.allowTracked
      })
      await note($, now ? `📝 ${name} may now be written into files git tracks.` : `📝 ${name} is written only into git-ignored files again.`, now ? 'warning' : 'success')
    })()
  },
})

/** Call from the module's one `session.start` hook, after `next`: finds the project, registers /secrets. */
export async function startSecrets($: $, cwd: string): Promise<void> {
  let root: string | null = cwd ? cwd.replace(/\\/g, '/') : null
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeoutMs: 10_000 })
    // The main checkout's .git: every worktree of a repository shares its secrets.
    if (exitCode === 0 && stdout.trim()) root = stdout.trim().replace(/\\/g, '/').replace(/\/\.git\/?$/, '')
  } catch {
    // Not a git repository: the folder itself is the project.
  }
  await update($, projectAtom, () => ({ root, cwd }))
  await update($, revealAtom, () => null)
  if (!root) await update($, addScopeAtom, () => 'global')
  await $.command.register({
    name: SECRETS_COMMAND,
    description: 'nanoflow secrets: store, allow, copy and reveal secrets Claude uses without seeing them',
    argumentHint: '[undo]',
  })
  await publish($, await storeOrEmpty($))
}

export type SecretsOptions = {
  /** The user's `secretsAllowTrackedWrites` setting: every secret may be written into tracked files. */
  allowTrackedWrites: boolean
}

export const registerSecrets = (on: On, options: SecretsOptions): void => {
  M.allowTrackedWrites = options.allowTrackedWrites
  // ─── command, pane ─────────────────────────────────────────────────────────────────────────────

  on('command.run', { command: SECRETS_COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'undo') return { text: await undoPasted($) }
    await update($, noteAtom, () => null)
    const opened = await $.ui.open({ id: SECRETS_PANE, title: 'Secrets', focus: true })
    if (!opened.isPlaced) return { text: `Secrets: the pane is open but not shown: ${opened.reason}` }
    return { text: 'Secrets pane opened.' }
  }).catch(() => ({ text: 'Secrets: that failed; run `claude --debug` for the reason.' }))

  on('ui.render', { component: 'Pane', requestId: SECRETS_PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const root = await projectRoot($)
    const shown = await read($, revealAtom)
    // A reveal outlives its timer across a reload: past its time it is drawn hidden.
    const fresh = shown && (await $.clock.now()) - shown.at < REVEAL_MS ? shown : null
    let value: string | undefined
    if (fresh) {
      const { scope, name } = fromId(fresh.id)
      value = scopeOf(parseVaultStore(await $.store.get(VAULT_KEY)), scope, root)[name]?.value
    }
    return SecretsView(el, {
      secrets: await read($, listAtom),
      root,
      revealed: fresh && value !== undefined ? { id: fresh.id, value } : null,
      confirm: await read($, confirmAtom),
      renaming: await read($, renameAtom),
      note: await read($, noteAtom),
      form: await read($, formAtom),
      addScope: root ? await read($, addScopeAtom) : 'global',
      pasted: (await read($, pastedAtom))?.names ?? [],
      trackedForAll: M.allowTrackedWrites,
    }, handlers($))
  })

  // ─── the model's instructions: the names, never a value ─────────────────────────────────────────

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const names = Object.keys(effectiveEntries(await storeOrEmpty($), await projectRoot($))).sort()
    return { sections: [...composed.sections.filter(s => s.id !== SECTION_ID), { id: SECTION_ID, text: sectionText(names), scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // ─── reads of example files keep their assignment lines (they hold no real secrets) ───────────────

  on('tool.call', { tool: 'Read' }, ($, e, next) => {
    if (isExampleFile(e.file_path)) M.exampleIds.add(e.tool_use_id)
    return next(e)
  }).catch(($, e, next) => next(e))

  // ─── in: a placeholder filled in as the tool runs, only where the person allowed it ─────────────

  on('tool.call', { tool: ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const text = (field: string): string => (typeof input[field] === 'string' ? input[field] : '')
    if ((WRITTEN[tool] ?? []).some(field => text(field).includes(REDACTED_MARK))) {
      return { deny: `${tool} refused: the new content holds a «redacted:…» mark, which stands for a secret value you never saw; writing it would replace the real value in the file. Leave that line as it is (edit around it), or ask the user to change it.` }
    }
    const spec = FILLED[tool]
    if (!spec || !spec.fields.some(field => text(field).includes('{{secret:'))) return next(e)
    const used = [...new Set(spec.fields.flatMap(field => placeholderNames(text(field))))]
    const isFile = spec.shell === 'raw'
    const target = isFile ? text('file_path') : text('command')
    if (used.length > 0) {
      const entries = effectiveEntries(await storeOrEmpty($), await projectRoot($))
      const missing = used.filter(name => entries[name] === undefined)
      if (missing.length) {
        const one = missing.length === 1
        return { deny: `secret ${missing.join(', ')} ${one ? "isn't" : "aren't"} in the vault; ask the user to add ${one ? 'it' : 'them'} with /secrets` }
      }
      // Into a git-ignored file only, unless the user allowed tracked files for each secret used (or for all).
      const mayTrack = M.allowTrackedWrites || used.every(name => entries[name]!.allowTracked === true)
      if (isFile && !mayTrack && !(await isIgnored($, target))) {
        return { deny: `${tool} refused: won't write a real secret into a tracked file (${target} is not ignored by git); the user can allow this in /secrets. Otherwise write it to a git-ignored file such as .env, or, to write the placeholder text itself, escape it as \\{{secret:NAME}}.` }
      }
      if (!isFile) {
        for (const name of used) {
          const blocked = disallowedUse(entries[name]!.allow, target)
          if (blocked) return { deny: `secret ${name} isn't allowed for ${blocked}; the user can allow it in /secrets` }
        }
      }
    }
    const vault = valuesOf(effectiveEntries(await storeOrEmpty($), await projectRoot($)))
    const filled: Record<string, unknown> = { ...input }
    for (const field of spec.fields) if (typeof input[field] === 'string') filled[field] = substitute(input[field], vault, spec.shell).text
    if (used.length > 0) {
      const where = isFile ? (target.split(/[\\/]/).pop() ?? target) : (firstProgram(target) ?? tool)
      $.ui.toast(`🔐 Used ${used.join(', ')} in ${where}`)
    }
    return next(filled as unknown as typeof e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'nanoflow secrets could not check this call; try again.' }))

  // ─── out: what the model reads is masked before it is kept ───────────────────────────────────────

  // session.append is where the rows of a running conversation enter it (tool results of every tool and
  // subagent loop, deliveries, hook context, compaction), and what it keeps is what the model is sent. The
  // screen's record of a tool result is stored as made. See docs/secrets.md for what it does not cover.
  on('session.append', async ($, e, next) => {
    const masked = redactContent(e.message.content, await maskValues($), M.exampleIds)
    return next(masked ? { ...e, message: { ...e.message, content: masked.content } } : e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // The hook failed or overran: mask with the values last read, and every known format.
    const masked = redactContent(e.message.content, M.lastValues, M.exampleIds)
    return next(masked ? { ...e, message: { ...e.message, content: masked.content } } : e)
  })

  // What the engine injects per request (a mentioned file, a changed file's diff, a hook's context).
  on('prompt.attachment', async ($, e, next) => {
    const injected = await next(e)
    if (!injected.text) return injected
    const masked = redact(injected.text, await maskValues($))
    return masked.hits.length ? { text: masked.text } : injected
  }).catch(async ($, e, next) => {
    const injected = await next(e)
    return injected.text ? { text: redact(injected.text, M.lastValues).text } : injected
  })

  // A message leaving for another agent or session.
  on('session.send', async ($, e, next) => {
    const masked = redact(e.text, await maskValues($))
    return next(masked.hits.length ? { ...e, text: masked.text } : e)
  }).catch(($, e, next) => (next.called ? next(e) : next({ ...e, text: redact(e.text, M.lastValues).text })))

  // ─── the person's own words: a pasted token is vaulted before the model reads it ─────────────────

  on('prompt.submit', async ($, e, next) => {
    // A slash command's line is masked at command.run; a hidden prompt that starts a turn takes no rewrite.
    if (e.command || (e.isMeta && !e.turnId)) return next(e)
    const masked = await vaultPasted($, e.text)
    return next(masked ? { ...e, text: masked.text } : e)
  }).catch(($, e, next) => {
    if (next.called || e.command || (e.isMeta && !e.turnId)) return next(e)
    return next({ ...e, text: redact(e.text, M.lastValues).text })
  })

  // Every command's arguments (a known limit: a command that takes a credential gets the placeholder).
  on('command.run', async ($, e, next) => {
    if (!e.args || e.command === SECRETS_COMMAND) return next(e)
    const masked = await vaultPasted($, e.args)
    return next(masked ? { ...e, args: masked.text } : e)
  }).catch(($, e, next) => (next.called ? next(e) : next({ ...e, args: redact(e.args, M.lastValues).text })))
}
