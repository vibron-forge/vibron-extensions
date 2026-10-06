// =============================================================================
// Dots state: the specialists a project defines, their transcripts for display,
// and the prompt a turn sends. Pure: no DOM, no host, so it is testable in node
// and the panel wiring in main.ts stays thin.
//
// Storage is Vibron's extension KV (one JSON file per project). Everything read
// from it goes through a sanitizer, because the file is hand-editable and an
// older version of this extension may have written it.
// =============================================================================

export interface Dot {
  id: string
  name: string
  /** One line: what this specialist is for. Shown in the list. */
  role: string
  /** The standing instructions, sent as the preface of its first turn. */
  instructions: string
  /** A Vibron agent profile (Settings → Agents) whose route the Dot's session
   *  opens on. Optional: without it, or when the profile is disabled, the Dot
   *  runs on the agent's default model. */
  profileId?: string
  createdAt: number
}

export interface DotsState {
  version: 1
  dots: Dot[]
  selectedId: string | null
}

export type TranscriptRole = 'you' | 'dot' | 'error' | 'note'
export interface TranscriptEntry { role: TranscriptRole; text: string; at: number }

export const STATE_KEY = 'dots'
export const TRANSCRIPT_KEY = (dotId: string) => `transcript:${dotId}`
export const SESSIONS_KEY = 'sessions'

export const NAME_MAX = 60
export const ROLE_MAX = 160
export const INSTRUCTIONS_MAX = 8000
export const TRANSCRIPT_MAX = 200
export const DOTS_MAX = 32
/** Longest turn text accepted from the composer. */
export const TURN_MAX = 20_000

/** Four specialists to start from; the user edits or deletes them. */
export function defaultDots(now: number): Dot[] {
  // Each seed names the native Vibron profile it corresponds to; the session
  // opens on that profile's route when the profile is enabled.
  const seed = (id: string, name: string, role: string, profileId: string, instructions: string): Dot => ({ id, name, role, instructions, profileId, createdAt: now })
  return [
    seed('planner', 'Planner', 'Turns a goal into a reviewable plan.', 'planner',
      'You are the project planner. Read the relevant code before proposing anything. Answer with a short plan: goal, assumptions, ordered steps, verifiable success criteria, and risks. Do not edit files unless asked.'),
    seed('coding', 'Coding', 'Implements a bounded change and verifies it.', 'coding',
      'You are the implementer. Make surgical changes with tests, run the relevant checks, and report what changed and what you verified. Ask before widening the scope.'),
    seed('reviewer', 'Reviewer', 'Reviews a change for correctness and clarity.', 'qa',
      'You are a code reviewer. Read the diff and the surrounding code. Report findings ordered by severity, each with the failure scenario and the file and line. Do not fix anything; the author does.'),
    seed('researcher', 'Researcher', 'Answers questions from code and docs with sources.', 'research',
      'You are the researcher. Answer from the repository and the official documentation, cite file paths or URLs for every claim, and say plainly when something could not be found.'),
  ]
}

export function emptyState(now: number): DotsState {
  const dots = defaultDots(now)
  return { version: 1, dots, selectedId: dots[0]?.id ?? null }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number): string | null => typeof value === 'string' ? value.replace(/\0/g, '').slice(0, max) : null

/** `/^[a-z0-9][a-z0-9-]{0,39}$/`: ids become storage keys. */
export function validDotId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value)
}

export function sanitizeDot(value: unknown): Dot | null {
  if (!isRecord(value) || !validDotId(value.id)) return null
  const name = text(value.name, NAME_MAX)?.trim()
  if (!name) return null
  const profileId = text(value.profileId, 80)?.trim()
  return {
    id: value.id,
    name,
    role: text(value.role, ROLE_MAX)?.trim() ?? '',
    instructions: text(value.instructions, INSTRUCTIONS_MAX)?.trim() ?? '',
    ...(profileId ? { profileId } : {}),
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0,
  }
}

/** What was stored, or a fresh state when nothing usable was. Duplicate ids
 *  keep the first; a selection that names no dot falls back to the first dot. */
export function sanitizeState(value: unknown, now: number): DotsState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.dots)) return emptyState(now)
  const seen = new Set<string>()
  const dots: Dot[] = []
  for (const raw of value.dots) {
    const dot = sanitizeDot(raw)
    if (dot && !seen.has(dot.id) && dots.length < DOTS_MAX) { seen.add(dot.id); dots.push(dot) }
  }
  const selectedId = typeof value.selectedId === 'string' && seen.has(value.selectedId) ? value.selectedId : dots[0]?.id ?? null
  return { version: 1, dots, selectedId }
}

/** A slug from the name that no existing dot uses. */
export function newDotId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'dot'
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) { const candidate = `${base}-${n}`; if (!taken.includes(candidate)) return candidate }
}

export type DotDraft = Pick<Dot, 'name' | 'role' | 'instructions' | 'profileId'>

export function validateDraft(draft: DotDraft): string | null {
  if (!draft.name.trim()) return 'A Dot needs a name.'
  if (draft.name.length > NAME_MAX) return `The name is longer than ${NAME_MAX} characters.`
  if (draft.role.length > ROLE_MAX) return `The role is longer than ${ROLE_MAX} characters.`
  if (draft.instructions.length > INSTRUCTIONS_MAX) return `The instructions are longer than ${INSTRUCTIONS_MAX} characters.`
  return null
}

export function addDot(state: DotsState, draft: DotDraft, now: number): { state: DotsState; dot: Dot } | { error: string } {
  const error = validateDraft(draft)
  if (error) return { error }
  if (state.dots.length >= DOTS_MAX) return { error: `A project holds at most ${DOTS_MAX} Dots.` }
  const dot: Dot = { id: newDotId(draft.name, state.dots.map(d => d.id)), ...fields(draft), createdAt: now }
  return { state: { ...state, dots: [...state.dots, dot], selectedId: dot.id }, dot }
}

const fields = (draft: DotDraft): Pick<Dot, 'name' | 'role' | 'instructions' | 'profileId'> => ({
  name: draft.name.trim(), role: draft.role.trim(), instructions: draft.instructions.trim(), ...(draft.profileId?.trim() ? { profileId: draft.profileId.trim() } : {}),
})

export function updateDot(state: DotsState, id: string, draft: DotDraft): DotsState | { error: string } {
  const error = validateDraft(draft)
  if (error) return { error }
  if (!state.dots.some(dot => dot.id === id)) return { error: 'That Dot no longer exists.' }
  return { ...state, dots: state.dots.map(dot => dot.id === id ? { id: dot.id, createdAt: dot.createdAt, ...fields(draft) } : dot) }
}

export function removeDot(state: DotsState, id: string): DotsState {
  const dots = state.dots.filter(dot => dot.id !== id)
  return { ...state, dots, selectedId: state.selectedId === id ? dots[0]?.id ?? null : state.selectedId }
}

export function selectDot(state: DotsState, id: string | null): DotsState {
  return { ...state, selectedId: id !== null && state.dots.some(dot => dot.id === id) ? id : state.selectedId }
}

export function sanitizeTranscript(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) return []
  const roles: TranscriptRole[] = ['you', 'dot', 'error', 'note']
  const entries: TranscriptEntry[] = []
  for (const raw of value) {
    if (!isRecord(raw) || !roles.includes(raw.role as TranscriptRole)) continue
    const body = text(raw.text, TURN_MAX)
    if (body === null) continue
    entries.push({ role: raw.role as TranscriptRole, text: body, at: typeof raw.at === 'number' ? raw.at : 0 })
  }
  return entries.slice(-TRANSCRIPT_MAX)
}

export function appendEntry(transcript: readonly TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  return [...transcript, entry].slice(-TRANSCRIPT_MAX)
}

/** The stored `dotId -> sessionId` map. A session id is pi's session file path,
 *  opaque here; the host checks it on resume. */
export function sanitizeSessions(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const sessions: Record<string, string> = {}
  for (const [dotId, sessionId] of Object.entries(value)) {
    if (validDotId(dotId) && typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length < 4096) sessions[dotId] = sessionId
  }
  return sessions
}

/** The text one turn sends. The instructions go first on a session's first
 *  turn, framed so the model reads them as its standing brief; later turns are
 *  the user's text alone, since pi keeps the history. */
export function composePrompt(dot: Dot, input: string, firstTurn: boolean): string {
  const body = input.trim()
  if (!firstTurn || !dot.instructions) return body
  return [
    `You are "${dot.name}"${dot.role ? `, ${dot.role.replace(/\.+$/, '')}` : ''}. These are your standing instructions for this conversation:`,
    '',
    dot.instructions,
    '',
    '---',
    '',
    body,
  ].join('\n')
}
