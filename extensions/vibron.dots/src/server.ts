// =============================================================================
// The Dots server. Vibron spawns it per workspace with:
//   PORT            free loopback port to bind on 127.0.0.1
//   VIBRON_TOKEN    bearer the proxy injects on every request to us
//   WORKSPACE_ROOT  workspace root path on the runtime host
//   VIBRON_API      loopback URL that tunnels back into Vibron's reverse API
//
// It serves the panel (dist/public), writes pages into the project, and runs
// the schedule: while it is alive, a due, ARMED task opens its Dot's agent
// session through VIBRON_API, sends the prompt, saves the answer as a page and
// records the run. Tasks and runs live in vibron.storage through the same API,
// so they survive restarts and the panel sees them. Dependency-free at runtime.
//
// Arming is the safety rule: storage.json is a file in the project, and a
// repository could ship it. A task read back from storage never runs a model
// turn until a human resumes it or runs it in the panel, in this server's
// life; a task created through the panel is armed by that creation.
//
// Routes (all but /health need Authorization: Bearer $VIBRON_TOKEN):
//   GET  /health                 readiness (auth-exempt)
//   GET  /, /app.js, /assets/*   the panel
//   GET  /api/pages              list pages
//   POST /api/pages              { title, content, dotId? } -> { page }
//   GET  /api/schedule           { tasks, armed, runs, running, tickMs }
//   POST /api/schedule           TaskDraft -> { task }
//   POST /api/schedule/:id/pause | resume | run | delete
//   POST /api/schedule/cancel    abort the run in flight
// =============================================================================

import http from 'http'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { PAGES_DIR, parsePage, renderPage, uniqueSlug, validateDraft, validSlug, type PageDraft, type PageInfo } from './pages'
import { RUNS_KEY, SCHEDULE_KEY, TASKS_MAX, appendRun, armed, newTask, nextDue, sanitizeRuns, sanitizeTasks, settleInterrupted, validateTaskDraft, type ArmedTasks, type ScheduledTask, type TaskDraft, type TaskRun } from './schedule'
import { STATE_KEY, composePrompt, sanitizeState, type Dot } from './state'

const PORT = Number(process.env.PORT)
const TOKEN = process.env.VIBRON_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || ''
const VIBRON_API = process.env.VIBRON_API || ''
/** How often the loop looks for a due task. */
const TICK_MS = Number(process.env.DOTS_TICK_MS) || 30_000
/** A turn that has not answered in this long is cancelled and the run fails. */
const TURN_TIMEOUT_MS = Number(process.env.DOTS_TURN_TIMEOUT_MS) || 15 * 60_000
const HOST_TIMEOUT_MS = 30_000
/** How long a deferred task (the agent was busy) waits before trying again. */
const DEFER_MS = 60_000
const BODY_LIMIT = 2_000_000
const PUBLIC_DIR = path.join(__dirname, 'public')
const PANEL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors *"
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.map': 'application/json; charset=utf-8' }

if (!PORT || !WORKSPACE_ROOT) { console.error('dots: PORT and WORKSPACE_ROOT are required'); process.exit(1) }

// --- host API ---------------------------------------------------------------
/** One `vibron.*` call over the reverse API. The endpoint answers `{ result }`
 *  (or the bare value); an `{ error }` result is returned, not thrown. A call
 *  that does not answer in `timeoutMs` rejects, so a stuck host never stalls
 *  the schedule. */
function host(method: string, args: Record<string, unknown> = {}, timeoutMs = HOST_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!VIBRON_API) { reject(new Error('VIBRON_API not set')); return }
    const body = JSON.stringify({ method, args })
    const url = new URL(VIBRON_API)
    const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname || '/', method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${TOKEN}` } }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode !== 200) { reject(new Error(`VIBRON_API ${response.statusCode}: ${text.slice(0, 200)}`)); return }
        try { const parsed = JSON.parse(text); resolve(parsed && typeof parsed === 'object' && 'result' in parsed ? parsed.result : parsed) } catch { resolve(text) }
      })
    })
    request.on('timeout', () => { request.destroy(new Error(`VIBRON_API timeout after ${timeoutMs} ms on ${method}`)) })
    request.on('error', reject)
    request.end(body)
  })
}
const storageGet = (key: string) => host('vibron.storage.get', { key })
const storageSet = (key: string, value: unknown) => host('vibron.storage.set', { key, value })
const notify = (message: string, level: 'info' | 'warn' | 'error' = 'info') => host('vibron.ui.notify', { message, level }).catch(() => undefined)

// --- pages ------------------------------------------------------------------
const pagesDir = path.join(WORKSPACE_ROOT, ...PAGES_DIR)

/** The pages directory, confined: it is created under the workspace root and
 *  every component of it must be a real directory, never a symlink, so a link
 *  planted in the repository cannot point the writes elsewhere. */
function confinedPagesDir(): string {
  const root = fs.realpathSync(WORKSPACE_ROOT)
  let current = root
  for (const segment of PAGES_DIR) {
    current = path.join(current, segment)
    let stat: fs.Stats
    try { stat = fs.lstatSync(current) } catch { fs.mkdirSync(current); continue }
    if (stat.isSymbolicLink()) throw new Error(`refusing ${current}: it is a symbolic link`)
    if (!stat.isDirectory()) throw new Error(`refusing ${current}: not a directory`)
  }
  if (fs.realpathSync(current) !== current || !current.startsWith(root + path.sep)) throw new Error('pages directory is outside the workspace')
  return current
}

function listPages(): PageInfo[] {
  if (!fs.existsSync(pagesDir)) return []
  const dir = confinedPagesDir()
  return fs.readdirSync(dir).filter(name => name.endsWith('.md') && validSlug(name.slice(0, -3))).flatMap(name => {
    const file = path.join(dir, name)
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return []
    const fd = fs.openSync(file, 'r')
    try { const head = Buffer.alloc(Math.min(stat.size, 4096)); fs.readSync(fd, head, 0, head.length, 0); return [parsePage(name.slice(0, -3), head.toString('utf8'), stat.size)] }
    finally { fs.closeSync(fd) }
  }).sort((a, b) => b.createdAt - a.createdAt)
}

function savePage(draft: PageDraft, now: number): PageInfo | { error: string } {
  const error = validateDraft(draft)
  if (error) return { error }
  const dir = confinedPagesDir()
  const slug = uniqueSlug(draft.title, listPages().map(page => page.slug))
  const text = renderPage(draft, now)
  // A fresh slug is never an existing file, and the exclusive flag makes that a guarantee, not a hope.
  fs.writeFileSync(path.join(dir, `${slug}.md`), text, { encoding: 'utf8', flag: 'wx' })
  return parsePage(slug, text, Buffer.byteLength(text))
}

// --- schedule ---------------------------------------------------------------
let tasks: ScheduledTask[] = []
let runs: TaskRun[] = []
const armedIds: ArmedTasks = new Set()
/** Tasks the agent was busy for, and when they may try again (in memory). */
const deferredUntil = new Map<string, number>()
let loading: Promise<void> | null = null
let running: TaskRun | null = null
let liveSession: string | null = null
let stopping = false

function loadState(): Promise<void> {
  loading ??= (async () => {
    tasks = sanitizeTasks(await storageGet(SCHEDULE_KEY))
    const stored = sanitizeRuns(await storageGet(RUNS_KEY))
    const settled = settleInterrupted(stored, Date.now())
    runs = settled
    if (settled.some((run, index) => run.status !== stored[index]?.status)) await storageSet(RUNS_KEY, runs)
  })().catch(error => { loading = null; throw error })
  return loading
}
const saveTasks = () => storageSet(SCHEDULE_KEY, tasks)
async function record(run: TaskRun): Promise<void> { runs = appendRun(runs, run); await storageSet(RUNS_KEY, runs) }

async function dotOf(dotId: string): Promise<Dot | null> {
  const state = sanitizeState(await storageGet(STATE_KEY), Date.now())
  return state.dots.find(dot => dot.id === dotId) ?? null
}

/** One run: the Dot's own session, one turn with its instructions as the
 *  preface, the answer saved as a page. A host that is busy (the panel has a
 *  live session of this extension) defers the task in memory, with no run
 *  record; any other failure is recorded with its reason. Whatever happens,
 *  the session is disposed and the loop is free again. */
async function runTask(task: ScheduledTask, now: number): Promise<void> {
  const run: TaskRun = { id: `run-${crypto.randomBytes(6).toString('hex')}`, taskId: task.id, dotId: task.dotId, startedAt: now, endedAt: null, status: 'running' }
  running = run
  let sessionId: string | null = null
  const finish = async (status: TaskRun['status'], extra: Partial<TaskRun> = {}) => {
    try { await record({ ...run, ...extra, status, endedAt: Date.now() }) } catch (error) { console.error('dots: could not record the run', error) }
  }
  try {
    const dot = await dotOf(task.dotId)
    if (!dot) { task.lastRunAt = now; await saveTasks(); await finish('failed', { detail: `Dot "${task.dotId}" no longer exists.` }); return }
    const opened = await host('vibron.agent.open', dot.profileId ? { profileId: dot.profileId } : {}) as { sessionId?: string; error?: string }
    if (!opened || typeof opened.sessionId !== 'string') {
      if (opened?.error === 'agent-busy') { deferredUntil.set(task.id, Date.now() + DEFER_MS); return }
      task.lastRunAt = now; await saveTasks()
      await finish('failed', { detail: `Could not open a session: ${opened?.error ?? 'unknown'}` })
      return
    }
    sessionId = liveSession = opened.sessionId
    task.lastRunAt = now
    await saveTasks()
    await record(run)
    const answer = await host('vibron.agent.send', { sessionId, prompt: composePrompt(dot, task.prompt, true) }, TURN_TIMEOUT_MS) as { text?: string; error?: string }
    if (!answer || typeof answer.text !== 'string') { await finish('failed', { detail: `The turn failed: ${answer?.error ?? 'unknown'}` }); return }
    const page = savePage({ title: `${task.title} — ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}`, content: answer.text || '(no text in the answer)', dotId: dot.id, source: 'schedule' }, Date.now())
    if ('error' in page) { await finish('failed', { detail: `The page could not be saved: ${page.error}` }); return }
    await finish('ok', { pageRelPath: page.relPath })
    void notify(`Dots: "${task.title}" saved ${page.relPath}`)
  } catch (error) {
    if (sessionId) await host('vibron.agent.cancel').catch(() => undefined)
    await finish('failed', { detail: error instanceof Error ? error.message : String(error) })
  } finally {
    if (sessionId) await host('vibron.agent.dispose', { sessionId }).catch(() => undefined)
    liveSession = null
    running = null
  }
}

async function tick(): Promise<void> {
  if (stopping || running) return
  try { await loadState() } catch { return }
  if (stopping || running) return
  const now = Date.now()
  const candidates = armed(tasks, armedIds).filter(task => (deferredUntil.get(task.id) ?? 0) <= now)
  const due = nextDue(candidates, now)
  if (due) await runTask(due, now).catch(error => console.error('dots: run failed', error))
}

// --- http -------------------------------------------------------------------
function authorized(req: http.IncomingMessage): boolean {
  const header = Buffer.from(String(req.headers.authorization || ''))
  const expected = Buffer.from(`Bearer ${TOKEN}`)
  return TOKEN.length > 0 && header.length === expected.length && crypto.timingSafeEqual(header, expected)
}
function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
  res.end(body)
}
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > BODY_LIMIT) { reject(new Error('body too large')); req.destroy() } else chunks.push(chunk) })
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(new Error('invalid JSON')) } })
    req.on('error', reject)
  })
}
function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = path.resolve(PUBLIC_DIR, rel)
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false
  const body = fs.readFileSync(file)
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...(file.endsWith('.html') ? { 'Content-Security-Policy': PANEL_CSP } : {}) })
  res.end(body)
  return true
}
const scheduleView = () => ({ tasks, armed: [...armedIds], runs, running: running?.id ?? null, tickMs: TICK_MS })

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/health') { json(res, 200, { ok: true }); return }
  if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return }
  try {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) { if (!serveStatic(res, url.pathname)) json(res, 404, { error: 'not found' }); return }
    await loadState()
    if (url.pathname === '/api/pages' && req.method === 'GET') { json(res, 200, { pages: listPages() }); return }
    if (url.pathname === '/api/pages' && req.method === 'POST') {
      const body = await readBody(req) as Partial<PageDraft>
      // A page from the panel is a reviewed conversation page; the schedule marks its own.
      const draft: PageDraft = { title: String(body.title ?? ''), content: String(body.content ?? ''), ...(typeof body.dotId === 'string' ? { dotId: body.dotId } : {}), source: 'conversation' }
      const page = savePage(draft, Date.now())
      if ('error' in page) { json(res, 400, page); return }
      json(res, 200, { page }); return
    }
    if (url.pathname === '/api/schedule' && req.method === 'GET') { json(res, 200, scheduleView()); return }
    if (url.pathname === '/api/schedule' && req.method === 'POST') {
      const body = await readBody(req) as Partial<TaskDraft>
      const draft: TaskDraft = { dotId: String(body.dotId ?? ''), title: String(body.title ?? ''), prompt: String(body.prompt ?? ''), everyMinutes: Number(body.everyMinutes) }
      const error = validateTaskDraft(draft) ?? (tasks.length >= TASKS_MAX ? `At most ${TASKS_MAX} tasks.` : !(await dotOf(draft.dotId)) ? 'That Dot does not exist.' : null)
      if (error) { json(res, 400, { error }); return }
      const task = newTask(draft, `task-${crypto.randomBytes(6).toString('hex')}`, Date.now())
      tasks = [...tasks, task]
      armedIds.add(task.id)
      await saveTasks()
      json(res, 200, { task }); return
    }
    if (url.pathname === '/api/schedule/cancel' && req.method === 'POST') {
      if (!running) { json(res, 200, { cancelled: false }); return }
      await host('vibron.agent.cancel').catch(() => undefined)
      json(res, 200, { cancelled: true, runId: running.id }); return
    }
    const action = /^\/api\/schedule\/([a-z0-9-]+)\/(pause|resume|run|delete)$/.exec(url.pathname)
    if (action && req.method === 'POST') {
      const task = tasks.find(candidate => candidate.id === action[1])
      if (!task) { json(res, 404, { error: 'no such task' }); return }
      if (action[2] === 'delete') { tasks = tasks.filter(candidate => candidate !== task); armedIds.delete(task.id); deferredUntil.delete(task.id) }
      else if (action[2] === 'pause') { task.paused = true; armedIds.delete(task.id) }
      else if (action[2] === 'resume') { task.paused = false; armedIds.add(task.id) }
      else { task.paused = false; task.lastRunAt = 0; armedIds.add(task.id); deferredUntil.delete(task.id) }
      await saveTasks()
      if (action[2] === 'run') setTimeout(() => { void tick() }, 0)
      json(res, 200, scheduleView()); return
    }
    json(res, 404, { error: 'not found' })
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dots: listening on 127.0.0.1:${PORT}`)
  const timer = setInterval(() => { void tick() }, TICK_MS)
  timer.unref()
  setTimeout(() => { void tick() }, 1000).unref()
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping = true
    // A run in flight is left `running`; the next start marks it interrupted.
    if (liveSession) void host('vibron.agent.cancel').catch(() => undefined)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
