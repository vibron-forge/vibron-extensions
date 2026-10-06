// =============================================================================
// One conversation per Dot on Vibron's embedded agent.
//
// The host allows one live agent session per extension and one turn in flight,
// so this is a small state machine: selecting a Dot disposes the live session
// and opens (or resumes) that Dot's own session; `send` runs one turn and files
// both sides into the Dot's transcript. pi keeps the real history in its
// session file; the transcript here is what the panel shows, bounded.
//
// The host is injected so the whole thing runs under a fake in tests.
// =============================================================================

import type { VibronHost } from './vibron-host'
import {
  SESSIONS_KEY, TRANSCRIPT_KEY, TURN_MAX, appendEntry, composePrompt, sanitizeSessions, sanitizeTranscript,
  type Dot, type TranscriptEntry,
} from './state'

export type ChatHost = Pick<VibronHost, 'agent'> & { storage: Pick<VibronHost['storage'], 'get' | 'set'> }

export interface ChatPorts {
  host: ChatHost
  now(): number
  /** Called after every transcript change for the Dot the panel shows. */
  changed(dotId: string, transcript: readonly TranscriptEntry[]): void
}

export type ChatStatus = 'idle' | 'opening' | 'thinking' | 'error'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function createDotChat(ports: ChatPorts) {
  const { host } = ports
  let current: { dot: Dot; sessionId: string; turns: number; model: { provider: string; model: string } | null } | null = null
  let busy = false
  let status: ChatStatus = 'idle'
  const transcripts = new Map<string, TranscriptEntry[]>()

  async function transcriptOf(dotId: string): Promise<TranscriptEntry[]> {
    let entries = transcripts.get(dotId)
    if (!entries) {
      entries = sanitizeTranscript(await host.storage.get(TRANSCRIPT_KEY(dotId)))
      transcripts.set(dotId, entries)
    }
    return entries
  }

  async function file(dotId: string, entry: Omit<TranscriptEntry, 'at'>): Promise<void> {
    const next = appendEntry(await transcriptOf(dotId), { ...entry, at: ports.now() })
    transcripts.set(dotId, next)
    await host.storage.set(TRANSCRIPT_KEY(dotId), next)
    ports.changed(dotId, next)
  }

  async function sessions(): Promise<Record<string, string>> {
    return sanitizeSessions(await host.storage.get(SESSIONS_KEY))
  }

  async function remember(dotId: string, sessionId: string | null): Promise<void> {
    const map = await sessions()
    if (sessionId === null) delete map[dotId]; else map[dotId] = sessionId
    await host.storage.set(SESSIONS_KEY, map)
  }

  /** Disposes the live session, if any. The session file stays for `resume`. */
  async function close(): Promise<void> {
    if (!current) return
    const live = current
    current = null
    try { await host.agent.dispose(live.sessionId) } catch { /* the host already dropped it */ }
  }

  /** Opens the Dot's session, resuming the one it had, on its profile's route
   *  when it names an enabled profile. A resume the host refuses (file gone,
   *  moved project) falls back to a fresh session; a profile the host refuses
   *  (disabled, removed) falls back to the default model. Both are said in
   *  the transcript, never silent. */
  async function open(dot: Dot): Promise<string | null> {
    status = 'opening'
    const known = (await sessions())[dot.id]
    const profile = dot.profileId ? { profileId: dot.profileId } : {}
    let result = await host.agent.open({ ...(known ? { resume: known } : {}), ...profile })
    let fresh = !known
    if ('error' in result && result.error === 'profile-unavailable' && dot.profileId) {
      await file(dot.id, { role: 'note', text: `Profile "${dot.profileId}" is not enabled; running on the agent's default model.` })
      result = await host.agent.open(known ? { resume: known } : {})
    }
    if ('error' in result && known) {
      await file(dot.id, { role: 'note', text: `Previous session could not be resumed (${result.error}); starting a new one.` })
      await remember(dot.id, null)
      result = await host.agent.open(profile)
      if ('error' in result && result.error === 'profile-unavailable') result = await host.agent.open({})
      fresh = true
    }
    if ('error' in result) {
      status = 'error'
      await file(dot.id, { role: 'error', text: `Could not open a session: ${result.error}` })
      return null
    }
    current = { dot, sessionId: result.sessionId, turns: fresh ? 0 : 1, model: result.model ?? null }
    await remember(dot.id, result.sessionId)
    status = 'idle'
    return result.sessionId
  }

  return {
    status: () => status,
    busy: () => busy,
    currentDotId: () => current?.dot.id ?? null,
    /** The model the live session runs on, as the host reported it. */
    currentModel: () => current?.model ?? null,
    transcriptOf,

    /** Makes `dot` the one the panel talks to. Only the transcript is loaded
     *  here; the session opens on the first send, so browsing Dots does not
     *  ask for consent or spawn agents. */
    async select(dot: Dot): Promise<TranscriptEntry[]> {
      if (busy) throw new Error('A turn is still running; wait for it or cancel it.')
      if (current && current.dot.id !== dot.id) await close()
      else if (current) current.dot = dot
      return transcriptOf(dot.id)
    },

    async send(dot: Dot, input: string): Promise<void> {
      const body = input.trim()
      if (!body) return
      if (body.length > TURN_MAX) throw new Error(`A turn is at most ${TURN_MAX} characters.`)
      if (busy) throw new Error('A turn is still running; wait for it or cancel it.')
      busy = true
      try {
        if (current && current.dot.id !== dot.id) await close()
        if (!current && await open(dot) === null) return
        const live = current!
        live.dot = dot
        await file(dot.id, { role: 'you', text: body })
        status = 'thinking'
        const result = await host.agent.send(live.sessionId, composePrompt(dot, body, live.turns === 0))
        if ('error' in result) {
          status = 'error'
          await file(dot.id, { role: 'error', text: result.error })
          return
        }
        live.turns++
        status = 'idle'
        await file(dot.id, { role: 'dot', text: result.text || '(no text in the answer)' })
      } catch (error) {
        status = 'error'
        await file(dot.id, { role: 'error', text: message(error) })
      } finally {
        busy = false
      }
    },

    async cancel(): Promise<void> {
      if (!busy) return
      try { await host.agent.cancel() } catch (error) { if (current) await file(current.dot.id, { role: 'error', text: `Cancel failed: ${message(error)}` }) }
    },

    /** Forgets the Dot's session and transcript: the next send starts over. */
    async reset(dot: Dot): Promise<void> {
      if (busy) throw new Error('A turn is still running; wait for it or cancel it.')
      if (current?.dot.id === dot.id) await close()
      await remember(dot.id, null)
      transcripts.set(dot.id, [])
      await host.storage.set(TRANSCRIPT_KEY(dot.id), [])
      ports.changed(dot.id, [])
    },

    /** Panel teardown: release the live session so another panel can open one. */
    dispose: close,
  }
}

export type DotChat = ReturnType<typeof createDotChat>
