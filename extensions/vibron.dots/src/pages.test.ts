import { describe, expect, it } from 'vitest'
import { parsePage, renderPage, slugify, uniqueSlug, validSlug, validateDraft } from './pages'

describe('pages', () => {
  it('slugs are file names under the pages dir and nothing else', () => {
    expect(slugify('Revisão do PR #12!')).toBe('revisao-do-pr-12')
    expect(slugify('***')).toBe('page')
    expect(uniqueSlug('Plan', ['plan', 'plan-2'])).toBe('plan-3')
    for (const bad of ['../x', 'a/b', 'A', '', 'x'.repeat(81), '.hidden']) expect(validSlug(bad)).toBe(false)
    expect(validSlug('plan-3')).toBe(true)
  })

  it('validates a draft', () => {
    expect(validateDraft({ title: ' ', content: 'x' })).toBe('A page needs a title.')
    expect(validateDraft({ title: 'T', content: '  ' })).toBe('A page needs content.')
    expect(validateDraft({ title: 'T', content: 'a\0b' })).toBe('The content holds a NUL byte.')
    expect(validateDraft({ title: 'T', content: 'ok' })).toBeNull()
  })

  it('renders a frontmatter the parser reads back, with CRLF normalised', () => {
    const text = renderPage({ title: ' Plan: "v2" ', content: 'line 1\r\nline 2\r\n', dotId: 'planner', source: 'schedule' }, Date.UTC(2026, 9, 6, 12))
    expect(text).toBe('---\ntitle: "Plan: \\"v2\\""\ncreated: "2026-10-06T12:00:00.000Z"\ndot: "planner"\nsource: "schedule"\n---\n\nline 1\nline 2\n')
    expect(parsePage('plan-v2', text, text.length)).toEqual({ slug: 'plan-v2', title: 'Plan: "v2"', relPath: '.vibron/dots/pages/plan-v2.md', dotId: 'planner', source: 'schedule', createdAt: Date.UTC(2026, 9, 6, 12), bytes: text.length })
    expect(parsePage('bare', '# No frontmatter\n', 17)).toEqual({ slug: 'bare', title: 'bare', relPath: '.vibron/dots/pages/bare.md', createdAt: 0, bytes: 17 })
    expect(parsePage('hand', '---\ntitle: Hand written\ncreated: nope\n---\nbody', 5).title).toBe('Hand written')
  })
})
