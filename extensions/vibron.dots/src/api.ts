// =============================================================================
// The panel's client for its own server. Every request is a RELATIVE URL under
// the proxy prefix (`/ext/<token>/`), so it tunnels through Vibron's proxy,
// which injects the bearer token; the webview never holds it.
// =============================================================================

import type { PageDraft, PageInfo } from './pages'
import type { ScheduledTask, TaskDraft, TaskRun } from './schedule'

export interface ScheduleView { tasks: ScheduledTask[]; armed: string[]; runs: TaskRun[]; running: string | null; tickMs: number }

/** This panel's public base path, e.g. "/ext/<routeToken>/". */
export const proxyBasePath = (): string => location.pathname.replace(/[^/]*$/, '')

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(proxyBasePath() + path, { cache: 'no-store', ...init })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}
const post = <T,>(path: string, body?: unknown): Promise<T> => call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })

export const api = {
  pages: () => call<{ pages: PageInfo[] }>('api/pages'),
  savePage: (draft: PageDraft) => post<{ page: PageInfo }>('api/pages', draft),
  schedule: () => call<ScheduleView>('api/schedule'),
  createTask: (draft: TaskDraft) => post<{ task: ScheduledTask }>('api/schedule', draft),
  taskAction: (id: string, action: 'pause' | 'resume' | 'run' | 'delete') => post<ScheduleView>(`api/schedule/${id}/${action}`),
  cancelRun: () => post<{ cancelled: boolean }>('api/schedule/cancel'),
}
