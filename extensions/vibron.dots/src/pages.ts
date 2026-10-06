// =============================================================================
// Pages: a Dot's work saved as a Markdown file in the project, under
// `.vibron/dots/pages/`. Pure helpers shared by the server (which writes the
// files) and the panel (which builds the review card). No filesystem here.
// =============================================================================

export const PAGES_DIR = ['.vibron', 'dots', 'pages'] as const
export const TITLE_MAX = 120
export const PAGE_MAX = 200_000

export interface PageDraft {
  title: string
  /** Markdown body, without the frontmatter. */
  content: string
  /** The Dot whose answer this is, when it is one. */
  dotId?: string
  /** Where it came from: a conversation turn or a scheduled run. */
  source?: 'conversation' | 'schedule'
}

export interface PageInfo {
  /** File name without the extension; also the page id. */
  slug: string
  title: string
  /** Path relative to the workspace root, with forward slashes. */
  relPath: string
  dotId?: string
  source?: string
  createdAt: number
  bytes: number
}

/** `/^[a-z0-9][a-z0-9-]{0,79}$/`: a slug is a file name under the pages dir
 *  and nothing else, so it can never climb out of it. */
export function validSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value)
}

/** Windows device names cannot be file names, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/

export function slugify(title: string): string {
  const base = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  if (!base) return 'page'
  return RESERVED.test(base) ? `${base}-page` : base
}

/** A slug no existing page uses: `title`, then `title-2`, `title-3`, … */
export function uniqueSlug(title: string, taken: readonly string[]): string {
  const base = slugify(title)
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) { const candidate = `${base}-${n}`; if (!taken.includes(candidate)) return candidate }
}

export function validateDraft(draft: PageDraft): string | null {
  if (!draft.title.trim()) return 'A page needs a title.'
  if (draft.title.length > TITLE_MAX) return `The title is longer than ${TITLE_MAX} characters.`
  if (!draft.content.trim()) return 'A page needs content.'
  if (draft.content.length > PAGE_MAX) return `The content is longer than ${PAGE_MAX} characters.`
  if (draft.content.includes('\0')) return 'The content holds a NUL byte.'
  return null
}

const yamlString = (value: string): string => JSON.stringify(value)

/** The file as written: a small YAML frontmatter the page list reads back,
 *  then the Markdown body. */
export function renderPage(draft: PageDraft, createdAt: number): string {
  const lines = ['---', `title: ${yamlString(draft.title.trim())}`, `created: ${yamlString(new Date(createdAt).toISOString())}`]
  if (draft.dotId) lines.push(`dot: ${yamlString(draft.dotId)}`)
  if (draft.source) lines.push(`source: ${yamlString(draft.source)}`)
  lines.push('---', '', draft.content.replace(/\r\n/g, '\n').trim(), '')
  return lines.join('\n')
}

/** Reads the frontmatter back; a file without one is listed by its slug. */
export function parsePage(slug: string, text: string, bytes: number): PageInfo {
  const info: PageInfo = { slug, title: slug, relPath: `${PAGES_DIR.join('/')}/${slug}.md`, createdAt: 0, bytes }
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'))
  if (!match) return info
  for (const line of match[1]!.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    try { value = JSON.parse(value) } catch { /* a hand-written value, kept as is */ }
    if (typeof value !== 'string') continue
    if (key === 'title' && value.trim()) info.title = value.trim().slice(0, TITLE_MAX)
    else if (key === 'created') { const at = Date.parse(value); if (Number.isFinite(at)) info.createdAt = at }
    else if (key === 'dot') info.dotId = value.slice(0, 40)
    else if (key === 'source') info.source = value.slice(0, 20)
  }
  return info
}
