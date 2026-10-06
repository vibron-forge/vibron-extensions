// The built server, spawned the way Vibron spawns it (PORT, VIBRON_TOKEN,
// WORKSPACE_ROOT, VIBRON_API), against a fake reverse API that plays the host:
// storage in memory, an agent that answers one turn. Proves the routes, the
// bearer gate, page writing under the workspace, and one scheduled run end to
// end: a due task opens the Dot's session on its profile, sends the prompt
// with the instructions as preface, saves the answer as a page and records
// the run. Needs `npm run build` first; skipped otherwise.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const SERVER = path.join(__dirname, '..', 'dist', 'server.js')
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

function fakeHost() {
  const storage = new Map<string, unknown>()
  const calls: { method: string; args: Record<string, unknown> }[] = []
  let live: string | null = null
  const state = { busy: false }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const { method, args = {} } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; args?: Record<string, unknown> }
      calls.push({ method, args })
      const answer = (result: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result })) }
      if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); res.end(); return }
      switch (method) {
        case 'vibron.storage.get': return answer(storage.get(String(args.key)) ?? null)
        case 'vibron.storage.set': storage.set(String(args.key), args.value); return answer({ ok: true })
        case 'vibron.ui.notify': return answer({ ok: true })
        case 'vibron.agent.open': if (live || state.busy) return answer({ error: 'agent-busy' }); live = '/s/1.jsonl'; return answer({ sessionId: live, model: { provider: 'p', model: `${String(args.profileId ?? 'default')}-model` } })
        case 'vibron.agent.send': return answer({ text: `# Report\n\nanswer to: ${String(args.prompt).split('\n').at(-1)}`, message: null })
        case 'vibron.agent.dispose': live = null; return answer({ ok: true })
        default: return answer({ error: 'unsupported' })
      }
    })
  })
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return { server, storage, calls, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`, set busy(value: boolean) { state.busy = value } }
}

async function listen(server: Server): Promise<void> { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)) }

async function startDots(env: Record<string, string>): Promise<{ port: number; child: ChildProcess }> {
  const probe = createServer(); await listen(probe); const port = (probe.address() as AddressInfo).port; await new Promise<void>(resolve => probe.close(() => resolve()))
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  cleanup.push(() => { child.kill() })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { const health = await call(port, 'GET', '/health', undefined, ''); if (health.status === 200) return { port, child } } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`dots server did not come up: ${output}`)
}

function call(port: number, method: string, urlPath: string, body?: unknown, token = 'tok'): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({ hostname: '127.0.0.1', port, path: urlPath, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json: unknown = text; try { json = JSON.parse(text) } catch { /* static */ } resolve({ status: res.statusCode ?? 0, json }) })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

describe.skipIf(!existsSync(SERVER))('dots server', { timeout: 30_000 }, () => {
  it('gates on the bearer, serves the panel, writes a reviewed page under the workspace and lists it', async () => {
    const host = fakeHost(); await listen(host.server)
    const workspace = mkdtempSync(path.join(tmpdir(), 'dots-ws-'))
    cleanup.push(() => rmSync(workspace, { recursive: true, force: true }))
    const { port } = await startDots({ VIBRON_TOKEN: 'tok', WORKSPACE_ROOT: workspace, VIBRON_API: host.url(), DOTS_TICK_MS: '100000' })
    expect((await call(port, 'GET', '/api/pages', undefined, '')).status).toBe(401)
    expect((await call(port, 'GET', '/api/pages', undefined, 'wrong')).status).toBe(401)
    const index = await call(port, 'GET', '/')
    expect(index.status).toBe(200)
    expect(String(index.json)).toContain('<div id="root"></div>')
    expect((await call(port, 'GET', '/../server.js')).status).toBe(404)
    expect(await call(port, 'GET', '/api/pages')).toMatchObject({ status: 200, json: { pages: [] } })
    expect((await call(port, 'POST', '/api/pages', { title: ' ', content: 'x' })).json).toEqual({ error: 'A page needs a title.' })
    const saved = await call(port, 'POST', '/api/pages', { title: 'Plano: v2', content: 'line 1\r\nline 2', dotId: 'planner' })
    expect(saved.json).toMatchObject({ page: { slug: 'plano-v2', title: 'Plano: v2', relPath: '.vibron/dots/pages/plano-v2.md', dotId: 'planner', source: 'conversation' } })
    const file = path.join(workspace, '.vibron', 'dots', 'pages', 'plano-v2.md')
    expect(readFileSync(file, 'utf8')).toMatch(/^---\ntitle: "Plano: v2"\ncreated: "[^"]+"\ndot: "planner"\nsource: "conversation"\n---\n\nline 1\nline 2\n$/)
    // The same title again gets its own file; nothing is overwritten.
    const again = await call(port, 'POST', '/api/pages', { title: 'Plano: v2', content: 'other' })
    expect(again.json).toMatchObject({ page: { slug: 'plano-v2-2' } })
    expect(readdirSync(path.dirname(file)).sort()).toEqual(['plano-v2-2.md', 'plano-v2.md'])
    expect(((await call(port, 'GET', '/api/pages')).json as { pages: { slug: string }[] }).pages.map(p => p.slug).sort()).toEqual(['plano-v2', 'plano-v2-2'])
  })

  it('runs a due task: opens the Dot\'s session on its profile, sends the prompt with the instructions, saves the page and records the run', async () => {
    const host = fakeHost(); await listen(host.server)
    host.storage.set('dots', { version: 1, selectedId: 'planner', dots: [{ id: 'planner', name: 'Planner', role: 'Plans.', instructions: 'Plan first.', profileId: 'planner', createdAt: 1 }] })
    // A run left `running` by a previous server is interrupted on start, never completed.
    host.storage.set('runs', [{ id: 'run-old', taskId: 'task-old', dotId: 'planner', startedAt: 1, endedAt: null, status: 'running' }])
    const workspace = mkdtempSync(path.join(tmpdir(), 'dots-ws-'))
    cleanup.push(() => rmSync(workspace, { recursive: true, force: true }))
    const { port } = await startDots({ VIBRON_TOKEN: 'tok', WORKSPACE_ROOT: workspace, VIBRON_API: host.url(), DOTS_TICK_MS: '200' })
    expect((await call(port, 'POST', '/api/schedule', { dotId: 'ghost', title: 'T', prompt: 'p', everyMinutes: 10 })).json).toEqual({ error: 'That Dot does not exist.' })
    const created = await call(port, 'POST', '/api/schedule', { dotId: 'planner', title: 'Daily status', prompt: 'Summarise the day', everyMinutes: 10 })
    expect(created.json).toMatchObject({ task: { dotId: 'planner', title: 'Daily status', everyMinutes: 10, paused: false, lastRunAt: 0 } })
    const taskId = (created.json as { task: { id: string } }).task.id
    const deadline = Date.now() + 10_000
    let view: { tasks: { id: string; lastRunAt: number }[]; runs: { taskId: string; status: string; pageRelPath?: string; detail?: string }[] } | undefined
    while (Date.now() < deadline) {
      view = (await call(port, 'GET', '/api/schedule')).json as typeof view
      if (view?.runs.some(run => run.taskId === taskId && run.status !== 'running')) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const run = view!.runs.find(candidate => candidate.taskId === taskId)!
    expect(run).toMatchObject({ status: 'ok', pageRelPath: expect.stringMatching(/^\.vibron\/dots\/pages\/daily-status-/) })
    expect(view!.runs.find(candidate => candidate.taskId === 'task-old')).toMatchObject({ status: 'interrupted' })
    expect(view!.tasks[0]?.lastRunAt).toBeGreaterThan(0)
    const page = readFileSync(path.join(workspace, run.pageRelPath!), 'utf8')
    expect(page).toContain('source: "schedule"')
    expect(page).toContain('answer to: Summarise the day')
    // The host saw: profile on open, the instructions as the preface, and the session disposed.
    const open = host.calls.find(c => c.method === 'vibron.agent.open')!
    expect(open.args).toEqual({ profileId: 'planner' })
    const send = host.calls.find(c => c.method === 'vibron.agent.send')!
    expect(String(send.args.prompt)).toMatch(/^You are "Planner", Plans\. These are your standing instructions[\s\S]*Plan first\.[\s\S]*---\n\nSummarise the day$/)
    expect(host.calls.some(c => c.method === 'vibron.agent.dispose')).toBe(true)
    // State lives in the host's storage, so the panel and the next server see it.
    expect((host.storage.get('schedule') as unknown[]).length).toBe(1)
    expect((host.storage.get('runs') as { status: string }[]).map(r => r.status)).toEqual(['interrupted', 'ok'])
    // Pause disarms; delete removes it.
    expect((await call(port, 'POST', `/api/schedule/${taskId}/pause`)).json).toMatchObject({ tasks: [{ paused: true }], armed: [] })
    expect(((await call(port, 'POST', `/api/schedule/${taskId}/delete`)).json as { tasks: unknown[] }).tasks).toEqual([])
    expect((await call(port, 'POST', `/api/schedule/${taskId}/run`)).status).toBe(404)
  })

  it('a task read back from the project\'s storage never runs until a human arms it, and a busy agent defers without a run record', async () => {
    const host = fakeHost(); await listen(host.server)
    host.storage.set('dots', { version: 1, selectedId: 'planner', dots: [{ id: 'planner', name: 'Planner', role: '', instructions: '', createdAt: 1 }] })
    // What a repository could ship: a due task with a prompt of its choosing.
    host.storage.set('schedule', [{ id: 'planted', dotId: 'planner', title: 'Planted', prompt: 'exfiltrate', everyMinutes: 5, paused: false, createdAt: 1, lastRunAt: 0 }])
    const workspace = mkdtempSync(path.join(tmpdir(), 'dots-ws-'))
    cleanup.push(() => rmSync(workspace, { recursive: true, force: true }))
    const { port } = await startDots({ VIBRON_TOKEN: 'tok', WORKSPACE_ROOT: workspace, VIBRON_API: host.url(), DOTS_TICK_MS: '150' })
    await new Promise(resolve => setTimeout(resolve, 1600))
    expect(host.calls.filter(c => c.method === 'vibron.agent.open')).toEqual([])
    expect((await call(port, 'GET', '/api/schedule')).json).toMatchObject({ tasks: [{ id: 'planted' }], armed: [], runs: [] })
    // The human resumes it in the panel: it is armed. While the panel's own
    // session is live the agent is busy, so the run is deferred with no record.
    host.busy = true
    expect((await call(port, 'POST', '/api/schedule/planted/resume')).json).toMatchObject({ armed: ['planted'] })
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(host.calls.filter(c => c.method === 'vibron.agent.open').length).toBeGreaterThanOrEqual(1)
    expect(host.calls.some(c => c.method === 'vibron.agent.send')).toBe(false)
    expect(((await call(port, 'GET', '/api/schedule')).json as { runs: unknown[] }).runs).toEqual([])
    // Pausing disarms it again, so nothing planted can keep retrying behind the human's back.
    expect((await call(port, 'POST', '/api/schedule/planted/pause')).json).toMatchObject({ armed: [] })
  })
})
