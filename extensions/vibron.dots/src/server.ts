// =============================================================================
// The Dots server. Vibron spawns it per workspace with:
//   PORT            free loopback port to bind on 127.0.0.1
//   VIBRON_TOKEN    bearer the proxy injects on every request to us
//   WORKSPACE_ROOT  workspace root path on the runtime host
//   VIBRON_API      loopback URL that tunnels back into Vibron's reverse API
//
// It serves the panel (dist/public), writes pages into the project, and runs
// the schedule: while it is alive, a due task opens its Dot's agent session
// through VIBRON_API, sends the prompt, saves the answer as a page and records
// the run. State (tasks, runs) lives in vibron.storage through the same API,
// so it survives restarts and the panel sees it. Dependency-free at runtime.
//
// Routes (all but /health need Authorization: Bearer $VIBRON_TOKEN):
//   GET  /health                 readiness (auth-exempt)
//   GET  /, /app.js, /assets/*   the panel
//   GET  /api/pages              list pages
//   POST /api/pages              { title, content, dotId?, source? } -> { page }
//   GET  /api/schedule           { tasks, runs, alive }
//   POST /api/schedule           TaskDraft -> { task }
//   POST /api/schedule/:id/pause | resume | run | delete
// =============================================================================

import http from 'http'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { PAGES_DIR, parsePage, renderPage, uniqueSlug, validateDraft, validSlug, type PageDraft, type PageInfo } from './pages'
import { RUNS_KEY, SCHEDULE_KEY, TASKS_MAX, appendRun, newTask, nextDue, sanitizeRuns, sanitizeTasks, settleInterrupted, validateTaskDraft, type ScheduledTask, type TaskDraft, type TaskRun } from './schedule'
import { STATE_KEY, composePrompt, sanitizeState, type Dot } from './state'

const PORT = Number(process.env.PORT)
const TOKEN = process.env.VIBRON_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || ''
const VIBRON_API = process.env.VIBRON_API || ''
/** How often the loop looks for a due task. */
const TICK_MS = Number(process.env.DOTS_TICK_MS) || 30_000
const BODY_LIMIT = 2_000_000
const PUBLIC_DIR = path.join(__dirname, 'public')
const PANEL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors *"
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.map': 'application/json; charset=utf-8' }

if (!PORT || !WORKSPACE_ROOT) { console.error('dots: PORT and WORKSPACE_ROOT are required'); process.exit(1) }

// --- host API ---------------------------------------------------------------
/** One `vibron.*` call over the reverse API. The endpoint answers `{ result }`
 *  (or the bare value); an `{ error }` result is returned, not thrown. */
function host(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!VIBRON_API) { reject(new Error('VIBRON_API not set')); return }
    const body = JSON.stringify({ method, args })
    const url = new URL(VIBRON_API)
    const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname || '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${TOKEN}` } }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode !== 200) { reject(new Error(`VIBRON_API ${response.statusCode}: ${text.slice(0, 200)}`)); return }
        try { const parsed = JSON.parse(text); resolve(parsed && typeof parsed === 'object' && 'result' in parsed ? parsed.result : parsed) } catch { resolve(text) }
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}
const storageGet = (key: string) => host('vibron.storage.get', { key })
const storageSet = (key: string, value: unknown) => host('vibron.storage.set', { key, value })
const notify = (message: string, level: 'info' | 'warn' | 'error' = 'info') => host('vibron.ui.notify', { message, level }).catch(() => undefined)

// --- pages ------------------------------------------------------------------
const pagesDir = path.join(WORKSPACE_ROOT, ...PAGES_DIR)

function listPages(): PageInfo[] {
  if (!fs.existsSync(pagesDir)) return []
  return fs.readdirSync(pagesDir).filter(name => name.endsWith('.md') && validSlug(name.slice(0, -3))).map(name => {
    const file = path.join(pagesDir, name)
    const stat = fs.statSync(file)
    // Only the head is needed for the frontmatter.
    const fd = fs.openSync(file, 'r')
    try { const head = Buffer.alloc(Math.min(stat.size, 4096)); fs.readSync(fd, head, 0, head.length, 0); return parsePage(name.slice(0, -3), head.toString('utf8'), stat.size) }
    finally { fs.closeSync(fd) }
  }).sort((a, b) => b.createdAt - a.createdAt)
}

function savePage(draft: PageDraft, now: number): PageInfo | { error: string } {
  const error = validateDraft(draft)
  if (error) return { error }
  fs.mkdirSync(pagesDir, { recursive: true })
  const slug = uniqueSlug(draft.title, listPages().map(page => page.slug))
  const file = path.join(pagesDir, `${slug}.md`)
  // A fresh slug is never an existing file, and the exclusive flag makes that a guarantee, not a hope.
  const text = renderPage(draft, now)
  fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' })
  return parsePage(slug, text, Buffer.byteLength(text))
}

// --- schedule ---------------------------------------------------------------
let tasks: ScheduledTask[] = []
let runs: TaskRun[] = []
let loaded = false
let running: TaskRun | null = null
let stopping = false

async function loadState(): Promise<void> {
  tasks = sanitizeTasks(await storageGet(SCHEDULE_KEY))
  const settled = settleInterrupted(sanitizeRuns(await storageGet(RUNS_KEY)), Date.now())
  runs = settled
  if (settled.some(run => run.status === 'interrupted' && run.endedAt === settled.at(-1)?.endedAt)) await storageSet(RUNS_KEY, runs)
  loaded = true
}
const saveTasks = () => storageSet(SCHEDULE_KEY, tasks)
async function record(run: TaskRun): Promise<void> { runs = appendRun(runs, run); await storageSet(RUNS_KEY, runs) }

async function dotOf(dotId: string): Promise<Dot | null> {
  const state = sanitizeState(await storageGet(STATE_KEY), Date.now())
  return state.dots.find(dot => dot.id === dotId) ?? null
}

/** One run: the Dot's own session, one turn with its instructions as the
 *  preface, the answer saved as a page. A host that is busy (the panel has a
 *  live session of this extension) defers the run to the next tick; any other
 *  failure is recorded with its reason. The session is always disposed. */
async function runTask(task: ScheduledTask, now: number): Promise<void> {
  const run: TaskRun = { id: `run-${crypto.randomBytes(6).toString('hex')}`, taskId: task.id, dotId: task.dotId, startedAt: now, endedAt: null, status: 'running' }
  running = run
  task.lastRunAt = now
  await saveTasks()
  await record(run)
  const finish = async (status: TaskRun['status'], extra: Partial<TaskRun> = {}) => { running = null; await record({ ...run, ...extra, status, endedAt: Date.now() }) }
  const dot = await dotOf(task.dotId)
  if (!dot) { await finish('failed', { detail: `Dot "${task.dotId}" no longer exists.` }); return }
  const opened = await host('vibron.agent.open', dot.profileId ? { profileId: dot.profileId } : {}) as { sessionId?: string; error?: string }
  if (!opened || typeof opened.sessionId !== 'string') {
    if (opened?.error === 'agent-busy') { task.lastRunAt = 0; await saveTasks(); await finish('deferred', { detail: 'The agent is busy with another session of Dots; the run waits for the next tick.' }); return }
    await finish('failed', { detail: `Could not open a session: ${opened?.error ?? 'unknown'}` })
    return
  }
  try {
    const answer = await host('vibron.agent.send', { sessionId: opened.sessionId, prompt: composePrompt(dot, task.prompt, true) }) as { text?: string; error?: string }
    if (!answer || typeof answer.text !== 'string') { await finish('failed', { detail: `The turn failed: ${answer?.error ?? 'unknown'}` }); return }
    const page = savePage({ title: `${task.title} — ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}`, content: answer.text || '(no text in the answer)', dotId: dot.id, source: 'schedule' }, Date.now())
    if ('error' in page) { await finish('failed', { detail: `The page could not be saved: ${page.error}` }); return }
    await finish('ok', { pageRelPath: page.relPath })
    void notify(`Dots: "${task.title}" saved ${page.relPath}`)
  } catch (error) {
    await finish('failed', { detail: error instanceof Error ? error.message : String(error) })
  } finally {
    await host('vibron.agent.dispose', { sessionId: opened.sessionId }).catch(() => undefined)
  }
}

async function tick(): Promise<void> {
  if (stopping || running) return
  if (!loaded) { try { await loadState() } catch { return } }
  const due = nextDue(tasks, Date.now())
  if (due) await runTask(due, Date.now()).catch(error => console.error('dots: run failed', error))
}

// --- http -------------------------------------------------------------------
const authorized = (req: http.IncomingMessage) => TOKEN.length > 0 && String(req.headers.authorization || '') === `Bearer ${TOKEN}`
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/health') { json(res, 200, { ok: true }); return }
  if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return }
  try {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) { if (!serveStatic(res, url.pathname)) json(res, 404, { error: 'not found' }); return }
    if (!loaded) await loadState()
    if (url.pathname === '/api/pages' && req.method === 'GET') { json(res, 200, { pages: listPages() }); return }
    if (url.pathname === '/api/pages' && req.method === 'POST') {
      const body = await readBody(req) as Partial<PageDraft>
      const draft: PageDraft = { title: String(body.title ?? ''), content: String(body.content ?? ''), ...(typeof body.dotId === 'string' ? { dotId: body.dotId } : {}), source: body.source === 'schedule' ? 'schedule' : 'conversation' }
      const page = savePage(draft, Date.now())
      if ('error' in page) { json(res, 400, page); return }
      json(res, 200, { page }); return
    }
    if (url.pathname === '/api/schedule' && req.method === 'GET') { json(res, 200, { tasks, runs, running: running?.id ?? null, tickMs: TICK_MS }); return }
    if (url.pathname === '/api/schedule' && req.method === 'POST') {
      const body = await readBody(req) as Partial<TaskDraft>
      const draft: TaskDraft = { dotId: String(body.dotId ?? ''), title: String(body.title ?? ''), prompt: String(body.prompt ?? ''), everyMinutes: Number(body.everyMinutes) }
      const error = validateTaskDraft(draft) ?? (tasks.length >= TASKS_MAX ? `At most ${TASKS_MAX} tasks.` : !(await dotOf(draft.dotId)) ? 'That Dot does not exist.' : null)
      if (error) { json(res, 400, { error }); return }
      const task = newTask(draft, `task-${crypto.randomBytes(6).toString('hex')}`, Date.now())
      tasks = [...tasks, task]
      await saveTasks()
      json(res, 200, { task }); return
    }
    const action = /^\/api\/schedule\/([a-z0-9-]+)\/(pause|resume|run|delete)$/.exec(url.pathname)
    if (action && req.method === 'POST') {
      const task = tasks.find(candidate => candidate.id === action[1])
      if (!task) { json(res, 404, { error: 'no such task' }); return }
      if (action[2] === 'delete') tasks = tasks.filter(candidate => candidate !== task)
      else if (action[2] === 'pause') task.paused = true
      else if (action[2] === 'resume') task.paused = false
      else { task.paused = false; task.lastRunAt = 0 }
      await saveTasks()
      if (action[2] === 'run') setTimeout(() => { void tick() }, 0)
      json(res, 200, { tasks }); return
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
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
