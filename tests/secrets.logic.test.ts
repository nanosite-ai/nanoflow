// Secrets, the pure part. Every "secret" here is a fake built at run time (no token-shaped literal is
// committed, so no scanner trips on the repo).
import { describe, expect, test } from 'claude-code/testing'
import { statusLine } from '../hooks/progress'
import {
  base64, isValidName, nextPastedName, normalizeName, parseEnv, placeholderNames, redact, redactContent, sectionText, substitute,
} from '../hooks/secrets/redact'
import { fake, FAKES } from './fakes'

const KIND: Record<string, string> = { githubPat: 'github', stripeRestricted: 'stripe' }

describe('secrets: names and placeholders', () => {
  test('names are UPPER_SNAKE_CASE, normalized from what people type', () => {
    expect(isValidName('STRIPE_SECRET_KEY')).toBe(true)
    expect(isValidName('1KEY')).toBe(false)
    expect(isValidName('lower')).toBe(false)
    expect(normalizeName('api-key')).toBe('API_KEY')
    expect(normalizeName('9x')).toBe(null)
  })

  test('placeholders are found and filled; a missing name is reported, not filled', () => {
    const vault = { API_TOKEN: 'tok-' + fake(3) }
    expect(placeholderNames('a {{secret:API_TOKEN}} b {{secret:NOPE}} {{secret:API_TOKEN}}')).toEqual(['API_TOKEN', 'NOPE'])
    const out = substitute('curl -H "Authorization: Bearer {{secret:API_TOKEN}}" {{secret:NOPE}}', vault)
    expect(out.text).toBe(`curl -H "Authorization: Bearer ${vault.API_TOKEN}" {{secret:NOPE}}`)
    expect(out.missing).toEqual(['NOPE'])
  })

  test('PASTED_<n> takes the first free number', () => {
    expect(nextPastedName([])).toBe('PASTED_1')
    expect(nextPastedName(['PASTED_1', 'PASTED_3'])).toBe('PASTED_2')
  })
})

describe('secrets: redaction', () => {
  for (const [name, value] of Object.entries(FAKES)) {
    test(`a ${name} token is masked by its format`, () => {
      const out = redact(`before ${value} after`, {})
      expect(out.text).not.toContain(value)
      expect(out.text).toContain(`«redacted:${KIND[name] ?? name}»`)
      expect(out.text.startsWith('before ')).toBe(true)
    })
  }

  test('an assignment keeps its key and masks its value', () => {
    const value = 'fakeFAKE' + '1234'
    expect(redact(`DB_PASSWORD=${value}`, {}).text).toBe('DB_PASSWORD=«redacted:value»')
    expect(redact(`  "apiKey": "${value}",`, {}).text).toBe('  "apiKey": "«redacted:value»",')
    expect(redact(`export STRIPE_SECRET_KEY='${value}'`, {}).text).toBe("export STRIPE_SECRET_KEY='«redacted:value»'")
  })

  test('code that only names a secret is left alone', () => {
    for (const line of [
      'const apiKey = process.env.API_KEY',
      'TOKEN_TTL=3600',
      'monkey: banana',
      'const token = getToken()',
      'API_KEY={{secret:API_KEY}}',
      'password: ${DB_PASSWORD}',
      'isPrivate = true',
    ]) expect(redact(line, {}).text).toBe(line)
  })

  test('a vault value becomes its placeholder, in plain, base64 and URL-encoded form', () => {
    const value = 'fake/Value+' + fake(2) + '=x'
    const vault = { MY_SECRET: value }
    expect(redact(`got ${value}!`, vault).text).toBe('got {{secret:MY_SECRET}}!')
    expect(redact(`b64 ${base64(value)}`, vault).text).toContain('{{secret:MY_SECRET}}')
    expect(redact(`url ?k=${encodeURIComponent(value)}&x`, vault).text).toBe('url ?k={{secret:MY_SECRET}}&x')
    expect(redact('nothing here', vault).hits).toEqual([])
  })

  test('the longest value wins when one value contains another', () => {
    const short = 'abc' + fake(2)
    const vault = { SHORT: short, LONG: short + '-more' }
    expect(redact(`x ${short}-more y ${short}`, vault).text).toBe('x {{secret:LONG}} y {{secret:SHORT}}')
  })

  test('a pattern hit can be vaulted instead of masked', () => {
    const out = redact(`use ${FAKES.stripe}`, {}, () => 'PASTED_1')
    expect(out.text).toBe('use {{secret:PASTED_1}}')
    expect(out.hits).toEqual(['PASTED_1'])
  })

  test('a row: text blocks and tool results (string or blocks) are masked, the rest kept', () => {
    const vault = { API_TOKEN: 'tok-' + fake(3) }
    const content = [
      { type: 'text', text: `see ${vault.API_TOKEN}` },
      { type: 'tool_result', tool_use_id: 't1', content: `out ${FAKES.github}` },
      { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: FAKES.jwt }, { type: 'image', source: {} }] },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls' } },
    ]
    const out = redactContent(content, vault)!
    expect(JSON.stringify(out.content)).not.toContain(vault.API_TOKEN)
    expect(JSON.stringify(out.content)).not.toContain(FAKES.github)
    expect(JSON.stringify(out.content)).not.toContain(FAKES.jwt)
    expect(out.content[0]).toEqual({ type: 'text', text: 'see {{secret:API_TOKEN}}' })
    expect(out.content[3]).toBe(content[3])
    expect(redactContent([{ type: 'text', text: 'clean' }], vault)).toBe(null)
  })
})

describe('secrets: .env, prompt section, status line', () => {
  test('.env lines parse, quotes stripped, comments skipped', () => {
    const v1 = 'v1-' + fake(2)
    const text = `# comment\nexport API_TOKEN="${v1}"\nDB_URL=postgres://u:p@h/db # trailing\nempty=\n  lower-name = 'x y'\nnot a line\n`
    expect(parseEnv(text)).toEqual([
      { name: 'API_TOKEN', value: v1 },
      { name: 'DB_URL', value: 'postgres://u:p@h/db' },
      { name: 'LOWER_NAME', value: 'x y' },
    ])
  })

  test('the system section names secrets and holds no value', () => {
    const text = sectionText(['API_TOKEN', 'DB_PASSWORD'])
    expect(text).toContain('{{secret:NAME}}')
    expect(text).toContain('/secrets')
    expect(text).toContain('Available secret names: API_TOKEN, DB_PASSWORD.')
    expect(sectionText([])).toContain('The vault is empty.')
  })

  test('the status line counts the vault', () => {
    const snapshot = { version: 1 as const, generatedAt: '', mainRoot: 'C:/r', current: null, worktrees: [], board: null }
    expect(statusLine({ snapshot, checks: {}, running: null, skill: null, secrets: 3 })).toContain('🔐 3')
    expect(statusLine({ snapshot, checks: {}, running: null, skill: null, secrets: 0 })).not.toContain('🔐')
  })
})
