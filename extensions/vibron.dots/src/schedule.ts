// =============================================================================
// Scheduled work: a Dot runs a prompt every N minutes while the Dots server is
// alive, and saves the answer as a page. Pure rules (what is due, what a run
// record looks like, how stored state is read back); the loop lives in
// server.ts. State is kept in the extension's storage, so it survives server
// restarts and is visible to the panel.
// =============================================================================

export const SCHEDULE_KEY = 'schedule'
export const RUNS_KEY = 'runs'
export const RUNS_MAX = 50
export const TASKS_MAX = 20
export const PROMPT_MAX = 8000
export const TASK_TITLE_MAX = 80
export const EVERY_MIN = 5
export const EVERY_MAX = 7 * 24 * 60

export interface ScheduledTask {
  id: string
  dotId: string
  title: string
  prompt: string
  /** Period in minutes. */
  everyMinutes: number
  paused: boolean
  createdAt: number
  /** When the task last started a run, or 0. */
  lastRunAt: number
}

/** What arms a task: a human action in the panel, in this server's life.
 *  Tasks read back from storage start disarmed, because `storage.json` is a
 *  file in the project and a repository could ship it; nothing planted there
 *  runs a model turn until someone resumes it or runs it in the panel. The
 *  arming is in memory on purpose: a restart asks again. */
export type ArmedTasks = Set<string>

export function armed(tasks: readonly ScheduledTask[], armedIds: ArmedTasks): ScheduledTask[] {
  return tasks.filter(task => armedIds.has(task.id))
}

export type RunStatus = 'running' | 'ok' | 'failed' | 'interrupted' | 'deferred'

export interface TaskRun {
  id: string
  taskId: string
  dotId: string
  startedAt: number
  endedAt: number | null
  status: RunStatus
  /** The page the answer was saved to (relative path), on success. */
  pageRelPath?: string
  /** Why it failed or was deferred. */
  detail?: string
}

export interface TaskDraft { dotId: string; title: string; prompt: string; everyMinutes: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number): string | null => typeof value === 'string' ? value.replace(/\0/g, '').slice(0, max) : null
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)

export function validateTaskDraft(draft: TaskDraft): string | null {
  if (!validId(draft.dotId)) return 'Pick a Dot.'
  if (!draft.title.trim()) return 'A task needs a title.'
  if (draft.title.length > TASK_TITLE_MAX) return `The title is longer than ${TASK_TITLE_MAX} characters.`
  if (!draft.prompt.trim()) return 'A task needs a prompt.'
  if (draft.prompt.length > PROMPT_MAX) return `The prompt is longer than ${PROMPT_MAX} characters.`
  if (!Number.isInteger(draft.everyMinutes) || draft.everyMinutes < EVERY_MIN || draft.everyMinutes > EVERY_MAX) return `The period is between ${EVERY_MIN} minutes and 7 days.`
  return null
}

export function sanitizeTasks(value: unknown): ScheduledTask[] {
  if (!Array.isArray(value)) return []
  const tasks: ScheduledTask[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw) || !validId(raw.id) || !validId(raw.dotId) || seen.has(raw.id)) continue
    const title = text(raw.title, TASK_TITLE_MAX)?.trim()
    const prompt = text(raw.prompt, PROMPT_MAX)?.trim()
    const every = typeof raw.everyMinutes === 'number' && Number.isInteger(raw.everyMinutes) ? Math.min(EVERY_MAX, Math.max(EVERY_MIN, raw.everyMinutes)) : null
    if (!title || !prompt || every === null || tasks.length >= TASKS_MAX) continue
    seen.add(raw.id)
    tasks.push({ id: raw.id, dotId: raw.dotId, title, prompt, everyMinutes: every, paused: raw.paused === true,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0, lastRunAt: typeof raw.lastRunAt === 'number' ? raw.lastRunAt : 0 })
  }
  return tasks
}

export function sanitizeRuns(value: unknown): TaskRun[] {
  if (!Array.isArray(value)) return []
  const statuses: RunStatus[] = ['running', 'ok', 'failed', 'interrupted', 'deferred']
  const runs: TaskRun[] = []
  for (const raw of value) {
    if (!isRecord(raw) || !validId(raw.id) || !validId(raw.taskId) || !validId(raw.dotId) || !statuses.includes(raw.status as RunStatus)) continue
    runs.push({ id: raw.id, taskId: raw.taskId, dotId: raw.dotId, status: raw.status as RunStatus,
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0, endedAt: typeof raw.endedAt === 'number' ? raw.endedAt : null,
      ...(typeof raw.pageRelPath === 'string' ? { pageRelPath: raw.pageRelPath.slice(0, 400) } : {}), ...(typeof raw.detail === 'string' ? { detail: raw.detail.slice(0, 1000) } : {}) })
  }
  return runs.slice(-RUNS_MAX)
}

export function newTask(draft: TaskDraft, id: string, now: number): ScheduledTask {
  return { id, dotId: draft.dotId, title: draft.title.trim(), prompt: draft.prompt.trim(), everyMinutes: draft.everyMinutes, paused: false, createdAt: now, lastRunAt: 0 }
}

/** A task is due when it is not paused and its period has elapsed since its
 *  last start (a task that never ran is due at once). */
export function isDue(task: ScheduledTask, now: number): boolean {
  return !task.paused && (task.lastRunAt === 0 || now - task.lastRunAt >= task.everyMinutes * 60_000)
}

/** The next task to run: the due one that has waited longest. */
export function nextDue(tasks: readonly ScheduledTask[], now: number): ScheduledTask | null {
  const due = tasks.filter(task => isDue(task, now))
  due.sort((a, b) => a.lastRunAt - b.lastRunAt)
  return due[0] ?? null
}

export function appendRun(runs: readonly TaskRun[], run: TaskRun): TaskRun[] {
  return [...runs.filter(existing => existing.id !== run.id), run].slice(-RUNS_MAX)
}

/** A server that starts and finds a run still `running` did not see it end:
 *  it is `interrupted`. Never completed on anyone's behalf; the task runs
 *  again on its next period once it is armed. */
export function settleInterrupted(runs: readonly TaskRun[], now: number): TaskRun[] {
  return runs.map(run => run.status === 'running' ? { ...run, status: 'interrupted' as const, endedAt: now, detail: 'The Dots server stopped while this run was in progress.' } : run)
}
