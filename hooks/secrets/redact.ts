// Secrets: the pure part. Names, placeholders, the .env parser, and the redaction that keeps every
// secret value out of what the model reads. No `$` here, so all of it is unit-tested directly.

/** A vault: secret name → value. Lives in `$.store` under VAULT_KEY, never in `$.state`. */
export type Vault = Readonly<Record<string, string>>

export const VAULT_KEY = 'secrets.vault'
export const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
export const PASTED_PREFIX = 'PASTED_'
/** `{{secret:NAME}}`: what the model writes where a value goes, and what it reads where one was. */
export const PLACEHOLDER_RE = /\{\{secret:([A-Za-z0-9_]{1,64})\}\}/g
/** Exact values shorter than this are not redacted by value (too many false hits); patterns still apply. */
export const MIN_VALUE_LENGTH = 6

export const placeholder = (name: string): string => `{{secret:${name}}}`
export const redactedMark = (kind: string): string => `«redacted:${kind}»`

export const isValidName = (name: string): boolean => NAME_RE.test(name)

/** Uppercase, non-name characters to `_`; null when nothing usable is left. */
export const normalizeName = (raw: string): string | null => {
  const name = raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64)
  return isValidName(name) ? name : null
}

// ─── patterns ────────────────────────────────────────────────────────────────────────────────────

export type SecretPattern = { kind: string; re: RegExp }

/** Known token formats. Each regex is global; the whole match is the secret. */
export const PATTERNS: readonly SecretPattern[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: 'npm', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: 'stripe', re: /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|rk_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,})/g },
  { kind: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'ndv', re: /\bndv_[A-Za-z0-9_-]{16,}/g },
]

/**
 * `NAME=value`, `NAME: "value"`, `"apiKey": "value"`: a key that says secret, then a value. Groups: 1 the key
 * (kept, with its separator), 2 the quote, 3 the value (masked). Never inside a `{{secret:NAME}}`.
 */
const ASSIGNMENT_RE =
  /(?<!\{\{)\b([A-Za-z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|PASS|PEPPER|PRIVATE|CREDENTIAL)[A-Za-z0-9_]*["']?\s*[:=]\s*)(["']?)([^\s"'`,;)}\]]+)\2/gi

const REFERENCE_RE = /^(?:\$|\{\{|«|<|process\.env|os\.environ|env\(|getenv|import\.meta|true$|false$|null$|undefined$|none$)/i
const IDENTIFIER_PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/

/**
 * Whether an assignment's value looks like a secret rather than code. Env-style keys (all caps) mask any
 * value of 6+ characters that is not a reference; code-style keys need a value that looks random.
 */
export const looksSecret = (key: string, value: string): boolean => {
  if (value.length < MIN_VALUE_LENGTH || REFERENCE_RE.test(value) || /^\d{1,11}$/.test(value)) return false
  const isEnvKey = key.replace(/["'\s:=]/g, '') === key.replace(/["'\s:=]/g, '').toUpperCase()
  if (isEnvKey) return true
  if (IDENTIFIER_PATH_RE.test(value) && !/\d/.test(value)) return false
  return value.length >= 8 && /[A-Za-z]/.test(value) && (/\d/.test(value) || value.length >= 20)
}

// ─── encodings of a vault value (cheap extra forms the value may travel in) ─────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const utf8 = (text: string): number[] => {
  const out: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

export const base64 = (text: string): string => {
  const bytes = utf8(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (b === undefined ? '=' : B64[(n >> 6) & 63]!) + (c === undefined ? '=' : B64[n & 63]!)
  }
  return out
}

/** The value and the forms it is commonly carried in: base64 (no padding) and URL-encoded. */
export const formsOf = (value: string): string[] => {
  const forms = new Set([value, base64(value).replace(/=+$/, ''), encodeURIComponent(value)])
  return [...forms].filter(f => f.length >= MIN_VALUE_LENGTH)
}

// ─── redaction ───────────────────────────────────────────────────────────────────────────────────

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type Redaction = { text: string; hits: string[] }

/**
 * Masks every secret in `text`: vault values (and their encodings) become `{{secret:NAME}}`; known token
 * formats and secret-looking assignments become `«redacted:<kind>»`, or, when `onUnknown` names them, that
 * name's placeholder (how a pasted secret is vaulted). `hits` lists what was masked, by name or kind, so a
 * caller can tell whether anything was; it never holds a value.
 */
export const redact = (text: string, vault: Vault, onUnknown?: (value: string, kind: string) => string | null): Redaction => {
  const hits: string[] = []
  let out = text
  const entries = Object.entries(vault)
    .flatMap(([name, value]) => formsOf(value).map(form => ({ name, form })))
    .sort((a, b) => b.form.length - a.form.length)
  for (const { name, form } of entries) {
    if (!out.includes(form)) continue
    out = out.replace(new RegExp(escapeRe(form), 'g'), placeholder(name))
    hits.push(name)
  }
  const unknown = (value: string, kind: string): string => {
    const name = onUnknown?.(value, kind) ?? null
    hits.push(name ?? kind)
    return name ? placeholder(name) : redactedMark(kind)
  }
  for (const { kind, re } of PATTERNS) out = out.replace(re, match => unknown(match, kind))
  out = out.replace(ASSIGNMENT_RE, (whole, key: string, quote: string, value: string) =>
    looksSecret(key, value) ? `${key}${quote}${unknown(value, 'value')}${quote}` : whole,
  )
  return { text: out, hits }
}

/** Every `{{secret:NAME}}` in `text`, by name, once each. */
export const placeholderNames = (text: string): string[] => [...new Set([...text.matchAll(PLACEHOLDER_RE)].map(m => m[1]!))]

/** Fills `{{secret:NAME}}` from the vault; `missing` lists the names it has no value for (left as they were). */
export const substitute = (text: string, vault: Vault): { text: string; missing: string[] } => {
  const missing = new Set<string>()
  const filled = text.replace(PLACEHOLDER_RE, (whole, name: string) => {
    const value = vault[name]
    if (value === undefined) {
      missing.add(name)
      return whole
    }
    return value
  })
  return { text: filled, missing: [...missing] }
}

/** The next free `PASTED_<n>` name. */
export const nextPastedName = (taken: Iterable<string>): string => {
  const names = new Set(taken)
  let n = 1
  while (names.has(`${PASTED_PREFIX}${n}`)) n += 1
  return `${PASTED_PREFIX}${n}`
}

// ─── .env ────────────────────────────────────────────────────────────────────────────────────────

/** `KEY=VALUE` lines (`export ` allowed, quotes stripped, comments and blanks skipped), names normalized. */
export const parseEnv = (text: string): Array<{ name: string; value: string }> => {
  const out: Array<{ name: string; value: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const name = normalizeName(match[1]!)
    let value = match[2]!
    const quoted = /^(["'`])([\s\S]*)\1$/.exec(value)
    if (quoted) value = quoted[2]!
    else value = value.replace(/\s+#.*$/, '').trim()
    if (name && value) out.push({ name, value })
  }
  return out
}

// ─── the model's instructions ────────────────────────────────────────────────────────────────────

export const SECTION_ID = 'nanoflow:secrets'

/** The system-prompt section: how to use secrets without seeing them, and the names available. */
export const sectionText = (names: readonly string[]): string =>
  [
    '# Secrets',
    "The user keeps secrets (API keys, tokens, passwords) in nanoflow's vault, out of your sight. Never print, echo, log or ask the user to paste a secret value, and never try to read one back.",
    'Where a value is needed, write the placeholder {{secret:NAME}} in a Bash or PowerShell command, or in the content of a Write or Edit: it is filled in when the tool runs, and any value that comes back in output is shown to you as the placeholder again (or as «redacted:<kind>» for a secret the vault does not hold).',
    'If a secret you need is not in the vault, ask the user to add it with /secrets (the Secrets pane), naming it in UPPER_SNAKE_CASE.',
    names.length ? `Available secret names: ${names.join(', ')}.` : 'The vault is empty.',
  ].join('\n')

// ─── conversation rows ───────────────────────────────────────────────────────────────────────────

/** A content block as the Messages API spells it (`session.append`'s `message.content`). */
export type Block = { type: string; [field: string]: unknown }

const redactBlocks = (blocks: readonly Block[], vault: Vault, hits: string[]): Block[] =>
  blocks.map(block => {
    if (block.type === 'text' && typeof block.text === 'string') {
      const r = redact(block.text, vault)
      hits.push(...r.hits)
      return r.hits.length ? { ...block, text: r.text } : block
    }
    if (block.type === 'tool_result') {
      const content = block.content
      if (typeof content === 'string') {
        const r = redact(content, vault)
        hits.push(...r.hits)
        return r.hits.length ? { ...block, content: r.text } : block
      }
      if (Array.isArray(content)) return { ...block, content: redactBlocks(content as Block[], vault, hits) }
    }
    return block
  })

/**
 * A row's blocks with every secret masked: text blocks and each tool_result's content (a string or its
 * text blocks). Null when nothing needed masking, so the row passes untouched.
 */
export const redactContent = (content: readonly Block[], vault: Vault): { content: Block[]; hits: string[] } | null => {
  const hits: string[] = []
  const out = redactBlocks(content, vault, hits)
  return hits.length ? { content: out, hits } : null
}
