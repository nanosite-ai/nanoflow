// The pane's shared building blocks: colors and the small pieces every tab repeats. Reach for these
// before writing a Box/Text/Link by hand, and add a variant here rather than a one-off in a tab.
import type { Elements } from 'claude-code'
import type { NfTokens } from '../types'
import { ticketLabel } from './diff'
import { allTokens, formatTokens } from './usage'

export type PaneElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'> & { Input?: Elements['terminal']['Input'] }

type Child = ReturnType<Elements['terminal']['Text']> | false | null | undefined

/**
 * Semantic colors, as theme keys so they follow the person's light/dark theme. PRs keep GitHub's
 * meanings: open green, merged purple, closed red.
 */
export const COLOR = {
  current: 'claude',
  selected: 'suggestion',
  ok: 'success',
  bad: 'error',
  wait: 'warning',
  merged: 'merged',
  info: 'suggestion',
  muted: 'inactive',
  onBadge: 'inverseText',
} as const

/** Board column → badge color; an unknown column stays neutral. */
export const statusColor = (status: string | null): string => {
  const s = (status ?? '').toLowerCase()
  if (s.includes('progress')) return COLOR.wait
  if (s.includes('review')) return COLOR.merged
  if (s.includes('ready') || s.includes('todo')) return COLOR.info
  if (s.includes('done')) return COLOR.ok
  return COLOR.muted
}

/**
 * A horizontal, wrapping line of parts. `indent` lines it up under a card's title; a number nests it that
 * many levels deep (2 columns each).
 */
export const Row = (el: PaneElements, key: string, children: Child[], opts: { gap?: number; indent?: boolean | number; wrap?: boolean } = {}) => {
  const { Box } = el
  const levels = opts.indent === true ? 1 : opts.indent || 0
  return (
    <Box key={key} flexDirection="row" gap={opts.gap ?? 1} flexWrap={opts.wrap === false ? 'nowrap' : 'wrap'} {...(levels ? { paddingLeft: 2 * levels } : {})}>
      {children}
    </Box>
  )
}

/** Inverse text on a colored background. */
export const Badge = (el: PaneElements, key: string, text: string, color: string) => {
  const { Text } = el
  return <Text key={key} backgroundColor={color} color={COLOR.onBadge} bold>{` ${text} `}</Text>
}

/** A status glyph in its color, e.g. a CI ✅ or a running service's ●. */
export type Look = { icon: string; color: string }

export const Mark = (el: PaneElements, key: string, look: Look, text = '') => {
  const { Text } = el
  return <Text key={key} color={look.color}>{`${look.icon}${text}`}</Text>
}

/** A plain button that folds and unfolds what follows it: `▾ label` open, `▸ label` closed. */
export const Fold = (el: PaneElements, key: string, open: boolean, label: string, onPress: () => void) => {
  const { Button } = el
  return <Button key={key} plain label={`${open ? '▾' : '▸'} ${label}`} onPress={onPress} />
}

/** A board column as a badge in its color. */
export const StatusBadge = (el: PaneElements, key: string, status: string) => Badge(el, key, status, statusColor(status))

/** `🎫 #712` (or `🎫 ED-712`), linked to the ticket. */
export const TicketLink = (el: PaneElements, key: string, ticket: { number: number; key?: string; url: string }) => {
  const { Link, Text } = el
  const label = `🎫 ${ticketLabel(ticket)}`
  return ticket.url ? <Link key={key} href={ticket.url} label={label} /> : <Text key={key}>{label}</Text>
}

/** A link when there is somewhere to go, the same label as colored text otherwise. */
export const LinkOr = (el: PaneElements, key: string, href: string | null | undefined, label: string, color?: string) => {
  const { Link, Text } = el
  return href ? <Link key={key} href={href} label={label} /> : <Text key={key} color={color} dimColor={color === undefined}>{label}</Text>
}

/**
 * A line of token counts: `label 🪙 37.8M · in 530 · out 210k · cache read 36.7M · cache write 881k`, the
 * kinds dim. `extra` parts follow, e.g. a session count.
 */
export const Tokens = (
  el: PaneElements, key: string, label: string | null, t: NfTokens,
  opts: { indent?: boolean | number; bold?: boolean; color?: string; extra?: Child[] } = {},
) => {
  const { Text } = el
  return Row(el, key, [
    label !== null && <Text key={`${key}-label`} bold={opts.bold} color={opts.color}>{label}</Text>,
    <Text key={`${key}-all`} bold={opts.bold}>{`🪙 ${formatTokens(allTokens(t))}`}</Text>,
    <Text key={`${key}-in`} dimColor>{`in ${formatTokens(t.input)}`}</Text>,
    <Text key={`${key}-out`} dimColor>{`out ${formatTokens(t.output)}`}</Text>,
    <Text key={`${key}-read`} dimColor>{`cache read ${formatTokens(t.cacheRead)}`}</Text>,
    <Text key={`${key}-write`} dimColor>{`cache write ${formatTokens(t.cacheWrite)}`}</Text>,
    ...(opts.extra ?? []),
  ], { indent: opts.indent })
}
