import { describe, expect, it } from 'vitest'
import {
  DOTS_MAX, TRANSCRIPT_MAX, addDot, appendEntry, composePrompt, emptyState, newDotId, removeDot, sanitizeSessions, sanitizeState, sanitizeTranscript, selectDot, updateDot,
  type Dot, type DotsState,
} from './state'

const dot = (over: Partial<Dot> = {}): Dot => ({ id: 'reviewer', name: 'Reviewer', role: 'Reviews.', instructions: 'Be strict.', createdAt: 1, ...over })

describe('state', () => {
  it('seeds four specialists and selects the first', () => {
    const state = emptyState(7)
    expect(state.dots.map(d => d.id)).toEqual(['planner', 'coding', 'reviewer', 'researcher'])
    expect(state.selectedId).toBe('planner')
    expect(state.dots.every(d => d.createdAt === 7 && d.instructions.length > 0)).toBe(true)
  })

  it('sanitizes a hand-edited or older file: bad ids, duplicates, overlong text, dangling selection', () => {
    const state = sanitizeState({ version: 1, selectedId: 'gone', dots: [
      { id: 'Bad Id', name: 'x' }, { id: 'a', name: 'A', role: 'r'.repeat(500), instructions: 'i\0i', createdAt: 'no' },
      { id: 'a', name: 'dup' }, { id: 'b', name: '   ' }, { id: 'c', name: 'C' },
    ] }, 9)
    expect(state.dots.map(d => d.id)).toEqual(['a', 'c'])
    expect(state.dots[0]).toMatchObject({ name: 'A', role: 'r'.repeat(160), instructions: 'ii', createdAt: 0 })
    expect(state.selectedId).toBe('a')
    expect(sanitizeState({ version: 2 }, 3)).toEqual(emptyState(3))
    expect(sanitizeState(null, 3)).toEqual(emptyState(3))
    expect(sanitizeState({ version: 1, dots: [] }, 3)).toEqual({ version: 1, dots: [], selectedId: null })
  })

  it('caps the catalog and derives unique slugs from names', () => {
    expect(newDotId('Révisor de código!', [])).toBe('revisor-de-codigo')
    expect(newDotId('Reviewer', ['reviewer', 'reviewer-2'])).toBe('reviewer-3')
    expect(newDotId('***', [])).toBe('dot')
    let state: DotsState = { version: 1, dots: [], selectedId: null }
    for (let i = 0; i < DOTS_MAX; i++) { const r = addDot(state, { name: `D${i}`, role: '', instructions: '' }, 1); if ('error' in r) throw new Error(r.error); state = r.state }
    expect(addDot(state, { name: 'one more', role: '', instructions: '' }, 1)).toEqual({ error: `A project holds at most ${DOTS_MAX} Dots.` })
  })

  it('adds, updates, removes and selects without losing the selection unnecessarily', () => {
    const base = emptyState(1)
    const added = addDot(base, { name: '  QA ', role: 'Tests. ', instructions: ' x ' }, 2)
    if ('error' in added) throw new Error(added.error)
    expect(added.dot).toEqual({ id: 'qa', name: 'QA', role: 'Tests.', instructions: 'x', createdAt: 2 })
    expect(added.state.selectedId).toBe('qa')
    expect(addDot(base, { name: ' ', role: '', instructions: '' }, 2)).toEqual({ error: 'A Dot needs a name.' })
    const updated = updateDot(added.state, 'qa', { name: 'QA2', role: '', instructions: 'y' })
    if ('error' in updated) throw new Error(updated.error)
    expect(updated.dots.at(-1)).toMatchObject({ id: 'qa', name: 'QA2', instructions: 'y', createdAt: 2 })
    expect(updateDot(base, 'nope', { name: 'n', role: '', instructions: '' })).toEqual({ error: 'That Dot no longer exists.' })
    expect(removeDot(updated, 'qa').selectedId).toBe('planner')
    expect(removeDot(selectDot(updated, 'coding'), 'qa').selectedId).toBe('coding')
    expect(selectDot(base, 'missing').selectedId).toBe('planner')
  })

  it('bounds transcripts and sessions read from storage', () => {
    const many = Array.from({ length: TRANSCRIPT_MAX + 5 }, (_, i) => ({ role: 'you', text: String(i), at: i }))
    expect(sanitizeTranscript(many)).toHaveLength(TRANSCRIPT_MAX)
    expect(sanitizeTranscript(many)[0]?.text).toBe('5')
    expect(sanitizeTranscript([{ role: 'ghost', text: 'x' }, { role: 'dot', text: 42 }, { role: 'note', text: 'ok' }, 'junk'])).toEqual([{ role: 'note', text: 'ok', at: 0 }])
    expect(appendEntry(sanitizeTranscript(many), { role: 'dot', text: 'new', at: 1 }).at(-1)?.text).toBe('new')
    expect(sanitizeSessions({ planner: '/p/.vibron/vibron-agent/s.jsonl', 'Bad id': 'x', coding: '', qa: 7 })).toEqual({ planner: '/p/.vibron/vibron-agent/s.jsonl' })
    expect(sanitizeSessions('nope')).toEqual({})
  })

  it('prefaces only the first turn of a session with the instructions', () => {
    const first = composePrompt(dot(), '  Review PR 12  ', true)
    expect(first).toBe('You are "Reviewer", Reviews. These are your standing instructions for this conversation:\n\nBe strict.\n\n---\n\nReview PR 12')
    expect(composePrompt(dot(), 'Review PR 12', false)).toBe('Review PR 12')
    expect(composePrompt(dot({ instructions: '', role: '' }), 'Hi', true)).toBe('Hi')
  })
})
