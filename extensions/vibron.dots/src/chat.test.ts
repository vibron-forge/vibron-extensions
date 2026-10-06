import { describe, expect, it, vi } from 'vitest'
import { createDotChat, type ChatHost } from './chat'
import { SESSIONS_KEY, TRANSCRIPT_KEY, type Dot } from './state'

const planner: Dot = { id: 'planner', name: 'Planner', role: 'Plans.', instructions: 'Plan first.', createdAt: 1 }
const coder: Dot = { id: 'coding', name: 'Coding', role: 'Codes.', instructions: '', createdAt: 1 }

/** A host that behaves like Vibron's: one live session per extension, one turn
 *  in flight, and `resume` accepted only for ids it handed out. */
function fakeHost(options: { resumeFails?: boolean; sendError?: string } = {}) {
  const store = new Map<string, unknown>()
  let live: string | null = null
  let opened = 0
  let inFlight = false
  const prompts: string[] = []
  const host: ChatHost = {
    storage: { get: async key => store.get(key), set: async (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))) } },
    agent: {
      open: vi.fn(async (opts?: { resume?: string }) => {
        if (live) return { error: 'agent-busy' }
        if (opts?.resume && (options.resumeFails || !opts.resume.startsWith('/s/'))) return { error: 'invalid-resume' }
        live = opts?.resume ?? `/s/${++opened}.jsonl`
        return { sessionId: live }
      }),
      send: vi.fn(async (sessionId: string, prompt: string) => {
        if (sessionId !== live) return { error: 'no-session' }
        if (inFlight) return { error: 'agent-busy' }
        inFlight = true
        try { prompts.push(prompt); return options.sendError ? { error: options.sendError } : { text: `answer to: ${prompt.split('\n').at(-1)}`, message: null } } finally { inFlight = false }
      }),
      dispose: vi.fn(async (sessionId: string) => { if (sessionId === live) live = null }),
      cancel: vi.fn(async () => {}),
    },
  }
  return { host, store, prompts, live: () => live, opened: () => opened }
}

describe('dot chat', () => {
  it('opens a session on the first send, prefaces it with the instructions, and files both sides', async () => {
    const f = fakeHost()
    const changed = vi.fn()
    const chat = createDotChat({ host: f.host, now: () => 5, changed })
    await chat.select(planner)
    expect(f.host.agent.open).not.toHaveBeenCalled()
    await chat.send(planner, 'Plan the login page')
    expect(f.prompts).toEqual(['You are "Planner", Plans. These are your standing instructions for this conversation:\n\nPlan first.\n\n---\n\nPlan the login page'])
    await chat.send(planner, 'Shorter')
    expect(f.prompts[1]).toBe('Shorter')
    expect(f.store.get(TRANSCRIPT_KEY('planner'))).toEqual([
      { role: 'you', text: 'Plan the login page', at: 5 }, { role: 'dot', text: 'answer to: Plan the login page', at: 5 },
      { role: 'you', text: 'Shorter', at: 5 }, { role: 'dot', text: 'answer to: Shorter', at: 5 },
    ])
    expect(f.store.get(SESSIONS_KEY)).toEqual({ planner: '/s/1.jsonl' })
    expect(changed).toHaveBeenCalledTimes(4)
    expect(chat.status()).toBe('idle')
  })

  it('switching Dots disposes the live session and resumes the other Dot\'s own session', async () => {
    const f = fakeHost()
    const chat = createDotChat({ host: f.host, now: () => 1, changed: () => {} })
    await chat.send(planner, 'a')
    await chat.send(coder, 'b')
    expect(f.host.agent.dispose).toHaveBeenCalledWith('/s/1.jsonl')
    expect(f.live()).toBe('/s/2.jsonl')
    expect(f.prompts[1]).toBe('b')
    // Back to the planner: resumed, so no preface again.
    await chat.send(planner, 'c')
    expect(f.host.agent.open).toHaveBeenLastCalledWith({ resume: '/s/1.jsonl' })
    expect(f.prompts[2]).toBe('c')
    expect(f.opened()).toBe(2)
  })

  it('a resume the host refuses falls back to a fresh session and says so in the transcript', async () => {
    const f = fakeHost({ resumeFails: true })
    f.store.set(SESSIONS_KEY, { planner: '/s/old.jsonl' })
    const chat = createDotChat({ host: f.host, now: () => 1, changed: () => {} })
    await chat.send(planner, 'hello')
    const transcript = f.store.get(TRANSCRIPT_KEY('planner')) as { role: string; text: string }[]
    expect(transcript.map(e => e.role)).toEqual(['note', 'you', 'dot'])
    expect(transcript[0]?.text).toContain('could not be resumed (invalid-resume)')
    expect(f.store.get(SESSIONS_KEY)).toEqual({ planner: '/s/1.jsonl' })
    // A fresh session gets the preface.
    expect(f.prompts[0]).toContain('Plan first.')
  })

  it('files a failed turn as an error, refuses overlapping turns, and reset forgets the session', async () => {
    const f = fakeHost({ sendError: 'provider-down' })
    const chat = createDotChat({ host: f.host, now: () => 1, changed: () => {} })
    const first = chat.send(planner, 'x')
    await expect(chat.send(planner, 'y')).rejects.toThrow('A turn is still running')
    await expect(chat.select(coder)).rejects.toThrow('A turn is still running')
    await first
    expect(chat.status()).toBe('error')
    expect((f.store.get(TRANSCRIPT_KEY('planner')) as { role: string }[]).map(e => e.role)).toEqual(['you', 'error'])
    await chat.reset(planner)
    expect(f.store.get(TRANSCRIPT_KEY('planner'))).toEqual([])
    expect(f.store.get(SESSIONS_KEY)).toEqual({})
    expect(f.host.agent.dispose).toHaveBeenCalledWith('/s/1.jsonl')
    await expect(chat.send(planner, 'x'.repeat(20_001))).rejects.toThrow('at most 20000')
  })

  it('cancel only acts while a turn is in flight, and dispose releases the session', async () => {
    const f = fakeHost()
    const chat = createDotChat({ host: f.host, now: () => 1, changed: () => {} })
    await chat.cancel()
    expect(f.host.agent.cancel).not.toHaveBeenCalled()
    await chat.send(planner, 'a')
    await chat.dispose()
    expect(f.live()).toBeNull()
    expect(chat.currentDotId()).toBeNull()
  })
})
