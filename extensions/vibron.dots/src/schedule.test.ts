import { describe, expect, it } from 'vitest'
import { RUNS_MAX, appendRun, armed, isDue, newTask, nextDue, sanitizeRuns, sanitizeTasks, settleInterrupted, validateTaskDraft, type TaskRun } from './schedule'

const minute = 60_000

describe('schedule', () => {
  it('validates a task draft', () => {
    expect(validateTaskDraft({ dotId: 'Bad', title: 't', prompt: 'p', everyMinutes: 10 })).toBe('Pick a Dot.')
    expect(validateTaskDraft({ dotId: 'planner', title: ' ', prompt: 'p', everyMinutes: 10 })).toBe('A task needs a title.')
    expect(validateTaskDraft({ dotId: 'planner', title: 't', prompt: 'p', everyMinutes: 4 })).toMatch(/between 5 minutes/)
    expect(validateTaskDraft({ dotId: 'planner', title: 't', prompt: 'p', everyMinutes: 10.5 })).toMatch(/between 5 minutes/)
    expect(validateTaskDraft({ dotId: 'planner', title: 't', prompt: 'p', everyMinutes: 10 })).toBeNull()
  })

  it('a task is due when its period elapsed since its last start, and the longest-waiting due task goes first', () => {
    const a = newTask({ dotId: 'planner', title: 'A', prompt: 'p', everyMinutes: 10 }, 'a', 0)
    const b = { ...newTask({ dotId: 'coding', title: 'B', prompt: 'p', everyMinutes: 10 }, 'b', 0), lastRunAt: 5 * minute }
    const c = { ...a, id: 'c', paused: true }
    expect(isDue(a, 0)).toBe(true)
    expect(isDue(b, 14 * minute)).toBe(false)
    expect(isDue(b, 15 * minute)).toBe(true)
    expect(nextDue([b, a, c], 20 * minute)?.id).toBe('a')
    expect(nextDue([c], 20 * minute)).toBeNull()
    // Only armed tasks are candidates: a stored task nobody touched in this server's life is not.
    expect(nextDue(armed([b, a, c], new Set(['b'])), 20 * minute)?.id).toBe('b')
    expect(nextDue(armed([a], new Set()), 20 * minute)).toBeNull()
  })

  it('reads stored tasks and runs back defensively', () => {
    expect(sanitizeTasks([{ id: 'a', dotId: 'planner', title: 'A', prompt: 'p', everyMinutes: 1, paused: 'yes' }, { id: 'a', dotId: 'planner', title: 'dup', prompt: 'p', everyMinutes: 10 }, { id: 'b' }, 'junk']))
      .toEqual([{ id: 'a', dotId: 'planner', title: 'A', prompt: 'p', everyMinutes: 5, paused: false, createdAt: 0, lastRunAt: 0 }])
    const many: TaskRun[] = Array.from({ length: RUNS_MAX + 3 }, (_, i) => ({ id: `r${i}`, taskId: 'a', dotId: 'planner', startedAt: i, endedAt: i, status: 'ok' }))
    expect(sanitizeRuns(many)).toHaveLength(RUNS_MAX)
    expect(sanitizeRuns([{ id: 'x', taskId: 'a', dotId: 'planner', status: 'bogus' }])).toEqual([])
  })

  it('a run still running when the server starts is interrupted, never completed', () => {
    const runs = appendRun([], { id: 'r1', taskId: 'a', dotId: 'planner', startedAt: 1, endedAt: null, status: 'running' })
    const settled = settleInterrupted(runs, 9)
    expect(settled[0]).toMatchObject({ status: 'interrupted', endedAt: 9 })
    expect(appendRun(settled, { ...settled[0]!, status: 'ok', endedAt: 10 })).toHaveLength(1)
  })
})
