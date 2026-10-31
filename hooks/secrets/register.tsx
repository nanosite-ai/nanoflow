// Secrets: values the person keeps in nanoflow's vault and the model never sees. The model writes
// {{secret:NAME}}; tool.call fills it in as the tool runs; every row the model reads is masked on its way
// into the conversation (session.append), as are injected attachments and outgoing messages; a secret
// pasted into a prompt is vaulted as PASTED_<n> before the model reads it. Wired from ../register.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { NfTone } from '../../types'
import {
  isValidName, nextPastedName, parseEnv, placeholderNames, redact, redactContent, SECTION_ID, sectionText,
  substitute, VAULT_KEY, type Vault,
} from './redact'
import { SecretsView, type SecretsHandlers } from './view'

type $ = EngineInterface

export const SECRETS_PANE = 'nanoflow-secrets'
export const SECRETS_COMMAND = 'secrets'
export const REVEAL_MS = 10_000

/** The tools whose input may carry {{secret:NAME}}, and the fields filled in. */
export const FILLED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Bash: ['command'],
  PowerShell: ['command'],
  Write: ['content'],
  Edit: ['old_string', 'new_string'],
}

const listAtom = atom({ plugin: 'nanoflow', key: 'secrets' } as const, [])
const revealAtom = atom({ plugin: 'nanoflow', key: 'secretsReveal' } as const, null)
const confirmAtom = atom({ plugin: 'nanoflow', key: 'secretsConfirm' } as const, null)
const renameAtom = atom({ plugin: 'nanoflow', key: 'secretsRename' } as const, null)
const noteAtom = atom({ plugin: 'nanoflow', key: 'secretsNote' } as const, null)
const formAtom = atom({ plugin: 'nanoflow', key: 'secretsForm' } as const, 0)
const draftAtom = atom({ plugin: 'nanoflow', key: 'secretsDraft' } as const, '')

/** The vault's size, for the status line (nanoflow redraws it on every poll). */
export async function secretCount($: $): Promise<number> {
  return (await read($, listAtom)).length
}

/** Module state, reset by a reload: the session's folder, for a relative .env path. */
const M = { cwd: '' }

// ─── the vault ($.store; read fresh each time, so two sessions never overwrite each other's) ────

async function loadVault($: $): Promise<Record<string, string>> {
  const raw = await $.store.get(VAULT_KEY)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([name, value]) => isValidName(name) && typeof value === 'string')) as Record<string, string>
}

/** The vault for masking and filling in: never throws, so a store that cannot be read still leaves the patterns. */
async function vaultOrEmpty($: $): Promise<Record<string, string>> {
  try {
    return await loadVault($)
  } catch {
    return {}
  }
}

async function publish($: $, vault: Vault): Promise<void> {
  const list = Object.keys(vault).sort().map(name => ({ name, length: vault[name]!.length }))
  await update($, listAtom, () => list)
}

async function changeVault($: $, change: (vault: Record<string, string>) => Record<string, string>): Promise<Vault> {
  const vault = change({ ...(await loadVault($)) })
  await $.store.set(VAULT_KEY, vault)
  await publish($, vault)
  return vault
}

function note($: $, text: string, tone: NfTone = 'info') {
  return update($, noteAtom, () => ({ text, tone }))
}

/** Masks the secrets in a person's text, storing each one the vault lacks as PASTED_<n>. */
async function vaultPasted($: $, text: string): Promise<{ text: string; stored: string[] } | null> {
  const vault = await vaultOrEmpty($)
  const byValue = new Map(Object.entries(vault).map(([name, value]) => [value, name]))
  const added: Record<string, string> = {}
  const result = redact(text, vault, value => {
    const known = byValue.get(value)
    if (known) return known
    const name = nextPastedName([...Object.keys(vault), ...Object.keys(added)])
    added[name] = value
    byValue.set(value, name)
    return name
  })
  if (result.hits.length === 0) return null
  const stored = Object.keys(added)
  if (stored.length) {
    await changeVault($, current => ({ ...current, ...added }))
    $.ui.toast(`🔐 Stored as ${stored.join(', ')} — rename in /secrets`)
  }
  return { text: result.text, stored }
}

async function resolvePath($: $, raw: string): Promise<string> {
  const path = raw.trim().replace(/^["']|["']$/g, '')
  if (path.startsWith('~')) {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    return `${home.replace(/\\/g, '/')}${path.slice(1)}`
  }
  if (/^([A-Za-z]:)?[\\/]/.test(path) || !M.cwd) return path
  return `${M.cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${path}`
}

const handlers = ($: $): SecretsHandlers => ({
  copy: (name, surface) => {
    void (async () => {
      const value = (await loadVault($))[name]
      if (value === undefined) return void (await note($, `${name} is no longer in the vault.`, 'error'))
      const copied = await $.ui.copy({ text: value, surface: surface as never })
      await note($, copied.isCopied ? `📋 Copied ${name}` : `Could not copy ${name} (${copied.reason ?? 'no clipboard'})`, copied.isCopied ? 'success' : 'error')
    })()
  },
  reveal: name => {
    void (async () => {
      const at = await $.clock.now()
      await update($, revealAtom, () => ({ name, at }))
      $.clock.after(REVEAL_MS, () => void update($, revealAtom, shown => (shown?.name === name && shown.at === at ? null : shown)))
    })()
  },
  hide: () => void update($, revealAtom, () => null),
  askDelete: name => void update($, confirmAtom, () => name),
  cancel: () => void update($, confirmAtom, () => null),
  confirmDelete: name => {
    void (async () => {
      await changeVault($, vault => {
        delete vault[name]
        return vault
      })
      await update($, confirmAtom, () => null)
      await update($, revealAtom, shown => (shown?.name === name ? null : shown))
      await note($, `🗑 Deleted ${name}`, 'success')
    })()
  },
  startRename: name => void update($, renameAtom, current => (current === name ? null : name)),
  rename: (from, to) => {
    void (async () => {
      const name = to.trim().toUpperCase()
      if (!isValidName(name)) return void (await note($, `"${to.trim()}" is not a valid name: use A-Z, 0-9 and _, starting with a letter.`, 'error'))
      const vault = await loadVault($)
      if (name !== from && vault[name] !== undefined) return void (await note($, `${name} already exists.`, 'error'))
      await changeVault($, current => {
        const value = current[from]
        if (value === undefined) return current
        delete current[from]
        return { ...current, [name]: value }
      })
      await update($, renameAtom, () => null)
      await note($, `✏️ Renamed ${from} to ${name}`, 'success')
    })()
  },
  draftName: name => void update($, draftAtom, () => name),
  add: value => {
    void (async () => {
      const draft = await read($, draftAtom)
      const name = draft.trim().toUpperCase()
      if (!isValidName(name)) return void (await note($, 'Type a name first (A-Z, 0-9 and _, starting with a letter), then the value.', 'error'))
      if (!value) return void (await note($, 'The value is empty.', 'error'))
      await changeVault($, vault => ({ ...vault, [name]: value }))
      await update($, draftAtom, () => '')
      await update($, formAtom, n => n + 1)
      await note($, `🔐 Saved ${name}`, 'success')
    })()
  },
  importEnv: raw => {
    void (async () => {
      if (!raw.trim()) return
      const path = await resolvePath($, raw)
      const text = await $.fs.read(path).catch(() => null)
      if (text === null) return void (await note($, `Could not read ${path}.`, 'error'))
      const entries = parseEnv(text)
      if (entries.length === 0) return void (await note($, `No KEY=VALUE lines in ${path}.`, 'warning'))
      await changeVault($, vault => ({ ...vault, ...Object.fromEntries(entries.map(e => [e.name, e.value])) }))
      await update($, formAtom, n => n + 1)
      await note($, `📥 Imported ${entries.length} from ${path}: ${entries.map(e => e.name).join(', ')}`, 'success')
    })()
  },
})


/** Call from the module's one `session.start` hook, after `next`: registers /secrets, loads the names. */
export async function startSecrets($: $, cwd: string): Promise<void> {
  M.cwd = cwd
  await $.command.register({
    name: SECRETS_COMMAND,
    description: 'nanoflow secrets: store, copy and reveal secrets Claude uses as {{secret:NAME}} without seeing them',
  })
  await publish($, await loadVault($))
}

export const registerSecrets = (on: On): void => {
  // ─── session, command, pane ────────────────────────────────────────────────────────────────────

  on('command.run', { command: SECRETS_COMMAND }, async $ => {
    await update($, noteAtom, () => null)
    const opened = await $.ui.open({ id: SECRETS_PANE, title: 'Secrets', focus: true })
    if (!opened.isPlaced) return { text: `Secrets: the pane is open but not shown: ${opened.reason}` }
    return { text: 'Secrets pane opened.' }
  }).catch(() => ({ text: 'Secrets: that failed; run `claude --debug` for the reason.' }))

  on('ui.render', { component: 'Pane', requestId: SECRETS_PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const shown = await read($, revealAtom)
    const value = shown ? (await loadVault($))[shown.name] : undefined
    return SecretsView(el, {
      secrets: await read($, listAtom),
      revealed: shown && value !== undefined ? { name: shown.name, value } : null,
      confirm: await read($, confirmAtom),
      renaming: await read($, renameAtom),
      note: await read($, noteAtom),
      form: await read($, formAtom),
    }, handlers($))
  })

  // ─── the model's instructions: the names, never a value ─────────────────────────────────────────

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const names = Object.keys(await vaultOrEmpty($)).sort()
    return { sections: [...composed.sections.filter(s => s.id !== SECTION_ID), { id: SECTION_ID, text: sectionText(names), scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // ─── in: {{secret:NAME}} filled in as the tool runs ────────────────────────────────────────────

  on('tool.call', { tool: ['Bash', 'PowerShell', 'Write', 'Edit'] }, async ($, e, next) => {
    const fields = FILLED_FIELDS[String(e.tool)]
    if (!fields) return next(e)
    const input = e as unknown as Record<string, unknown>
    const used = fields.flatMap(field => (typeof input[field] === 'string' ? placeholderNames(input[field]) : []))
    if (used.length === 0) return next(e)
    const vault = await loadVault($)
    const missing = used.filter(name => vault[name] === undefined)
    if (missing.length) {
      const one = missing.length === 1
      return { deny: `secret ${missing.join(', ')} ${one ? "isn't" : "aren't"} in the vault; ask the user to add ${one ? 'it' : 'them'} with /secrets` }
    }
    const filled: Record<string, unknown> = { ...input }
    for (const field of fields) if (typeof input[field] === 'string') filled[field] = substitute(input[field], vault).text
    return next(filled as unknown as typeof e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'nanoflow secrets could not fill in {{secret:...}} for this call; try again.' }))

  // ─── out: every row the model reads is masked before it is kept ──────────────────────────────────

  // session.append is where every row enters a conversation (tool results of every tool and subagent loop,
  // deliveries, hook context, compaction), and what it keeps is exactly what the model is sent. Rewriting
  // the text there masks the model's copy only: the screen's record of a tool result is stored as made.
  on('session.append', async ($, e, next) => {
    const masked = redactContent(e.message.content, await vaultOrEmpty($))
    return next(masked ? { ...e, message: { ...e.message, content: masked.content } } : e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // The vault could not be read: still mask every known token format.
    const masked = redactContent(e.message.content, {})
    return next(masked ? { ...e, message: { ...e.message, content: masked.content } } : e)
  })

  // What the engine injects per request (a mentioned file, a changed file's diff, a hook's context).
  on('prompt.attachment', async ($, e, next) => {
    const injected = await next(e)
    if (!injected.text) return injected
    const masked = redact(injected.text, await vaultOrEmpty($))
    return masked.hits.length ? { text: masked.text } : injected
  }).catch(($, e, next) => next(e))

  // A message leaving for another agent or session.
  on('session.send', async ($, e, next) => {
    const masked = redact(e.text, await vaultOrEmpty($))
    return next(masked.hits.length ? { ...e, text: masked.text } : e)
  }).catch(($, e, next) => (next.called ? next(e) : next({ ...e, text: redact(e.text, {}).text })))

  // ─── the person's own words: a pasted secret is vaulted before the model reads it ────────────────

  on('prompt.submit', async ($, e, next) => {
    // A slash command's line is masked at command.run; a hidden prompt that starts a turn takes no rewrite.
    if (e.command || (e.isMeta && !e.turnId)) return next(e)
    const masked = await vaultPasted($, e.text)
    return next(masked ? { ...e, text: masked.text } : e)
  }).catch(($, e, next) => {
    if (next.called || e.command || (e.isMeta && !e.turnId)) return next(e)
    return next({ ...e, text: redact(e.text, {}).text })
  })

  on('command.run', async ($, e, next) => {
    if (!e.args || e.command === SECRETS_COMMAND) return next(e)
    const masked = await vaultPasted($, e.args)
    return next(masked ? { ...e, args: masked.text } : e)
  }).catch(($, e, next) => next(e))
}
