// Fake secrets for the secrets tests, assembled at run time so the repository holds no complete token (no
// scanner trips on it, and nothing here was ever a real value).
export const fake = (n: number): string => 'FAKE'.repeat(n)

/** A random, real-looking fake value: letters and digits, `n` long. */
export const randomFake = (n: number): string => {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = 'f4'
  while (out.length < n) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

const pemLabel = ['RSA', 'PRIVATE', 'KEY'].join(' ')

/** One fake per high-confidence pattern kind. */
export const FAKES: Readonly<Record<string, string>> = {
  'private-key': `-----BEGIN ${pemLabel}-----\nMIIE${fake(8)}\n-----END ${pemLabel}-----`,
  jwt: ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiJGQUtFIn0', fake(5)].join('.'),
  anthropic: ['sk', 'ant', 'api03', fake(6)].join('-'),
  openai: ['sk', 'proj', fake(6)].join('-'),
  github: ['ghp', fake(9)].join('_'),
  githubPat: ['github', 'pat', fake(6)].join('_'),
  gitlab: ['glpat', fake(6)].join('-'),
  npm: ['npm', fake(9)].join('_'),
  stripe: ['sk', 'test', fake(6)].join('_'),
  stripeRestricted: ['rk', 'live', fake(6)].join('_'),
  slack: ['xox' + 'b', '0000', fake(3)].join('-'),
  aws: 'AKIA' + fake(4),
  google: 'AIza' + 'F'.repeat(35),
  huggingface: ['hf', fake(9)].join('_'),
  sendgrid: ['SG', fake(5), fake(11)].join('.'),
  ndv: ['ndv', fake(5)].join('_'),
}

/** The kind each fake is reported as. */
export const KIND: Readonly<Record<string, string>> = { githubPat: 'github', stripeRestricted: 'stripe' }

/** A random fake with no vowels: never reads as a camelCase identifier (`looksLikeIdentifier`). */
export const bareFake = (n: number): string => {
  const chars = 'bcdfghjkmnpqrstvwxzBCDFGHJKLMNPQRSTVWXZ23456789'
  let out = 'f4'
  while (out.length < n) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}
