// The pane's shared building blocks: colors and the small pieces every tab repeats. Reach for these
// before writing a Box/Text/Link by hand, and add a variant here rather than a one-off in a tab.
import type { Elements } from 'claude-code'

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

/** A horizontal, wrapping line of parts. `indent` lines it up under a card's title. */
export const Row = (el: PaneElements, key: string, children: Child[], opts: { gap?: number; indent?: boolean; wrap?: boolean } = {}) => {
  const { Box } = el
  return (
    <Box key={key} flexDirection="row" gap={opts.gap ?? 1} flexWrap={opts.wrap === false ? 'nowrap' : 'wrap'} {...(opts.indent ? { paddingLeft: 2 } : {})}>
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

/** A board column as a badge in its color. */
export const StatusBadge = (el: PaneElements, key: string, status: string) => Badge(el, key, status, statusColor(status))

/** `🎫 #712`, linked to the ticket. */
export const TicketLink = (el: PaneElements, key: string, ticket: { number: number; url: string }) => {
  const { Link } = el
  return <Link key={key} href={ticket.url} label={`🎫 #${ticket.number}`} />
}

/** A link when there is somewhere to go, the same label as colored text otherwise. */
export const LinkOr = (el: PaneElements, key: string, href: string | null | undefined, label: string, color?: string) => {
  const { Link, Text } = el
  return href ? <Link key={key} href={href} label={label} /> : <Text key={key} color={color} dimColor={color === undefined}>{label}</Text>
}
