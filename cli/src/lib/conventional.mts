// Conventional Commit PR titles, checked before the PR exists so CI never bounces it.
import type { TicketRefMode } from "./config.mjs";

export const COMMIT_TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "style", "revert"] as const;

/** Types that cut a release (fix/perf → patch, feat → minor). */
export const RELEASING_TYPES: readonly string[] = ["feat", "fix", "perf"];

export interface ParsedTitle {
  type: string;
  scope?: string;
  breaking: boolean;
  subject: string;
}

const HEADER_RE = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;
/** Lower-case start, no trailing period. */
const SUBJECT_RE = /^(?![A-Z]).+[^.]$/;
const TICKET_REF_RE = /#\d+/;
const BODY_REF_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+#\d+/i;

export const parseTitle = (title: string): ParsedTitle | null => {
  const m = HEADER_RE.exec(title.trim());
  return m ? { type: m[1], scope: m[2], breaking: Boolean(m[3]), subject: m[4] } : null;
};

/** What a Conventional Commit title check would report (empty = passes). */
export const prTitleProblems = (title: string): string[] => {
  const parsed = parseTitle(title);
  if (!parsed) return [`"${title}" is not a Conventional Commit: use "type(scope): subject (#N)".`];
  const problems: string[] = [];
  if (!(COMMIT_TYPES as readonly string[]).includes(parsed.type)) problems.push(`Type "${parsed.type}" is not one of: ${COMMIT_TYPES.join(", ")}.`);
  if (!SUBJECT_RE.test(parsed.subject)) problems.push(`Subject "${parsed.subject}" must start lower-case and not end with a period.`);
  return problems;
};

export const bodyLinksTicket = (body: string): boolean => BODY_REF_RE.test(body);

/** Whether text names the ticket: `#712` for a GitHub issue (any `#N`, as before), else the key itself. */
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namesTicket = (text: string, ref: string): boolean =>
  ref.startsWith("#") ? TICKET_REF_RE.test(text) : new RegExp(`(?<![\\w-])${escapeRegex(ref)}(?!\\w)`, "i").test(text);

/**
 * Name the ticket in a PR title, unless it already does. `ref` is `#712` or `ED-712`.
 * "suffix": `feat: x (#712)`. "scope": `feat(ED-712): x`, or the suffix when the title already has a scope.
 */
export const withTicketRef = (title: string, ref: string, mode: TicketRefMode = "suffix"): string => {
  const t = title.trim();
  if (mode === "none" || namesTicket(t, ref)) return t;
  const parsed = mode === "scope" ? parseTitle(t) : null;
  if (parsed && !parsed.scope) return `${parsed.type}(${ref})${parsed.breaking ? "!" : ""}: ${parsed.subject}`;
  return `${t} (${ref})`;
};

/** Whether a PR body already links the ticket: `Closes #712` for a GitHub issue, else the key anywhere. */
export const bodyNamesTicket = (body: string, ref: string): boolean => (ref.startsWith("#") ? bodyLinksTicket(body) : namesTicket(body, ref));

/** Default PR title from the branch's commits: the first releasing one (feat/fix/perf), else the first conventional one. */
export const titleFromCommits = (subjects: string[]): string | null => {
  const parsed = subjects.map((s) => ({ s, p: parseTitle(s) })).filter((x) => x.p);
  const releasing = parsed.find((x) => RELEASING_TYPES.includes(x.p!.type));
  return (releasing ?? parsed[0])?.s ?? null;
};
