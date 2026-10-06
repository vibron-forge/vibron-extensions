// =============================================================================
// The Dots panel: a list of specialists on the left, the selected one's
// conversation on the right. All state logic lives in state.ts and chat.ts;
// this file only renders and wires events. `mount` takes the host so the
// panel runs under a fake in tests and under window.vibron in Vibron.
// =============================================================================

import './styles.css'
import type { VibronHost } from './vibron-host'
import { applyTheme } from './theme'
import { createDotChat, type ChatHost } from './chat'
import { api, type ScheduleView } from './api'
import { validateDraft as validatePageDraft, type PageDraft } from './pages'
import { EVERY_MIN, validateTaskDraft, type TaskDraft } from './schedule'
import {
  STATE_KEY, addDot, removeDot, sanitizeState, selectDot, updateDot,
  type Dot, type DotDraft, type DotsState, type TranscriptEntry,
} from './state'

export type PanelHost = ChatHost & {
  theme?: Pick<VibronHost['theme'], 'get'>
  ui?: Pick<VibronHost['ui'], 'notify'>
  editor?: Pick<VibronHost['editor'], 'openFile'>
  workspace?: Pick<VibronHost['workspace'], 'get'>
  storage: Pick<VibronHost['storage'], 'get' | 'set' | 'onChange'>
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string; text?: string } = {}, ...children: (Node | string)[]) => {
  const node = document.createElement(tag)
  const { class: className, text, ...rest } = props
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  Object.assign(node, rest)
  node.append(...children)
  return node
}

export async function mount(root: HTMLElement, host: PanelHost, now: () => number = Date.now): Promise<{ dispose(): Promise<void> }> {
  try { applyTheme(await host.theme?.get() ?? null) } catch { applyTheme(null) }

  const stored = await host.storage.get(STATE_KEY)
  let state: DotsState = sanitizeState(stored, now())
  let transcript: TranscriptEntry[] = []
  const persist = async (next: DotsState) => { state = next; await host.storage.set(STATE_KEY, next) }
  // A project's first panel writes the seed, so a hand edit or a second panel starts from the same catalog.
  if (stored === undefined || stored === null) await persist(state)
  const selected = (): Dot | null => state.dots.find(dot => dot.id === state.selectedId) ?? null

  const chat = createDotChat({ host, now, changed: (dotId, entries) => { if (dotId === state.selectedId) { transcript = [...entries]; renderTranscript() } } })

  // --- DOM skeleton ---------------------------------------------------------
  const list = el('ul', { role: 'listbox' } as Partial<HTMLUListElement>)
  const addButton = el('button', { class: 'small', text: '+ New' })
  const title = el('span', { class: 'title' })
  const status = el('span', { class: 'status' })
  const editButton = el('button', { class: 'small', text: 'Edit' })
  const resetButton = el('button', { class: 'small', text: 'Reset' })
  const workButton = el('button', { class: 'small', text: 'Pages & schedule' })
  const drawer = el('aside', { class: 'drawer', hidden: true })
  const transcriptView = el('div', { class: 'transcript' })
  const input = el('textarea', { placeholder: 'Ask the selected Dot… (Enter sends, Shift+Enter is a new line)', rows: 2 })
  const sendButton = el('button', { class: 'primary', text: 'Send' })
  const cancelButton = el('button', { text: 'Cancel', disabled: true })
  const shell = el('div', { class: 'dots' },
    el('aside', { class: 'dots-list' }, el('header', {}, el('span', { text: 'Dots' }), addButton), list),
    el('section', { class: 'dots-chat' },
      el('header', {}, title, status, editButton, resetButton, workButton),
      transcriptView,
      el('div', { class: 'composer' }, input, sendButton, cancelButton)),
    drawer)
  root.replaceChildren(shell)

  // --- rendering ------------------------------------------------------------
  function renderList() {
    list.replaceChildren(...state.dots.map(dot => {
      const item = el('li', { role: 'option' } as Partial<HTMLLIElement>, el('div', { class: 'name', text: dot.name }), el('div', { class: 'role', text: dot.role }))
      item.setAttribute('aria-selected', String(dot.id === state.selectedId))
      item.dataset.dotId = dot.id
      item.addEventListener('click', () => { void choose(dot.id) })
      return item
    }))
    const dot = selected()
    title.textContent = dot ? dot.name : 'No Dot selected'
    editButton.disabled = resetButton.disabled = !dot
  }
  function renderStatus() {
    const current = chat.status()
    status.dataset.status = current
    const model = chat.currentModel()
    const dot = selected()
    const where = chat.currentDotId() === dot?.id && model ? `${model.provider}/${model.model}` : dot?.profileId ? `profile ${dot.profileId}` : ''
    status.textContent = current === 'thinking' ? 'thinking…' : current === 'opening' ? 'opening session…' : current === 'error' ? 'last turn failed' : where
    sendButton.disabled = chat.busy() || !selected()
    cancelButton.disabled = !chat.busy()
    input.disabled = !selected()
  }
  function renderTranscript() {
    const dot = selected()
    if (!dot) { transcriptView.replaceChildren(el('div', { class: 'empty', text: 'Create a Dot to start a conversation.' })); return }
    if (transcript.length === 0) {
      transcriptView.replaceChildren(el('div', { class: 'empty', text: dot.instructions ? `${dot.name} works under its instructions. Send the first message to open its session.` : `${dot.name} has no instructions yet. Edit it, or just send a message.` }))
      return
    }
    transcriptView.replaceChildren(...transcript.map(entry => {
      const node = el('div', { class: 'entry' }, el('span', { class: 'text', text: entry.text }))
      node.dataset.role = entry.role
      if (entry.role === 'dot') {
        // A Dot's answer can become a page in the project, after the human reviews it.
        const save = el('button', { class: 'small save-page', text: 'Save as page' })
        save.addEventListener('click', () => { void saveAsPage(entry.text) })
        node.append(el('div', { class: 'entry-actions' }, save))
      }
      return node
    }))
    transcriptView.scrollTop = transcriptView.scrollHeight
    renderStatus()
  }

  // --- pages & schedule (the extension's own server) --------------------------
  async function saveAsPage(content: string) {
    const dot = selected()
    const draft = await openPageReview(root, { title: dot ? `${dot.name}: ${content.split('\n')[0]?.slice(0, 60) ?? ''}` : '', content, ...(dot ? { dotId: dot.id } : {}), source: 'conversation' })
    if (!draft) return
    try {
      const { page } = await api.savePage(draft)
      await host.ui?.notify(`Saved ${page.relPath}`)
      const rootPath = (await host.workspace?.get())?.rootPath
      if (rootPath && host.editor) await host.editor.openFile(`${rootPath.replace(/[\\/]+$/, '')}/${page.relPath}`)
      if (!drawer.hidden) void renderDrawer()
    } catch (error) { await host.ui?.notify(error instanceof Error ? error.message : String(error), 'error') }
  }

  let drawerTimer: ReturnType<typeof setInterval> | undefined
  async function renderDrawer() {
    let schedule: ScheduleView | null = null, pages: Awaited<ReturnType<typeof api.pages>>['pages'] = [], failure = ''
    try { [schedule, pages] = await Promise.all([api.schedule(), api.pages().then(r => r.pages)]) } catch (error) { failure = error instanceof Error ? error.message : String(error) }
    const close = el('button', { class: 'small', text: 'Close' })
    close.addEventListener('click', () => { drawer.hidden = true; clearInterval(drawerTimer) })
    const head = el('header', {}, el('span', { class: 'title', text: 'Pages & schedule' }), close)
    if (!schedule) { drawer.replaceChildren(head, el('div', { class: 'empty', text: `The Dots server is not reachable: ${failure}` })); return }
    const dotName = (id: string) => state.dots.find(dot => dot.id === id)?.name ?? id
    const when = (at: number) => at ? new Date(at).toLocaleString() : 'never'
    const tasks = el('ul', { class: 'tasks' }, ...schedule.tasks.map(task => {
      const act = (action: 'pause' | 'resume' | 'run' | 'delete', label: string) => {
        const b = el('button', { class: 'small', text: label })
        b.addEventListener('click', () => { void (async () => {
          // Vibron allows one live agent session per extension: a run needs the
          // panel's own session released first (it resumes on the next send).
          if (action === 'run') { if (chat.busy()) { await host.ui?.notify('Wait for the running turn before running a task.', 'warn'); return } await chat.dispose() }
          await api.taskAction(task.id, action).then(renderDrawer, error => host.ui?.notify(String(error), 'error'))
        })() })
        return b
      }
      const last = [...schedule!.runs].reverse().find(run => run.taskId === task.id)
      const item = el('li', {}, el('div', { class: 'name', text: `${task.title} · ${dotName(task.dotId)} · every ${task.everyMinutes} min${task.paused ? ' · paused' : ''}` }),
        el('div', { class: 'role', text: last ? `last run ${when(last.startedAt)}: ${last.status}${last.pageRelPath ? ` → ${last.pageRelPath}` : last.detail ? ` (${last.detail})` : ''}` : 'not run yet' }),
        el('div', { class: 'entry-actions' }, task.paused ? act('resume', 'Resume') : act('pause', 'Pause'), act('run', 'Run now'), act('delete', 'Delete')))
      item.dataset.taskId = task.id
      item.dataset.lastStatus = last?.status ?? ''
      return item
    }))
    const form = taskForm(state.dots, async draft => {
      try { await api.createTask(draft); await renderDrawer() } catch (error) { await host.ui?.notify(error instanceof Error ? error.message : String(error), 'error') }
    })
    const pageList = el('ul', { class: 'pages' }, ...pages.map(page => {
      const open = el('button', { class: 'small', text: 'Open' })
      open.addEventListener('click', () => { void host.workspace?.get().then(ws => ws.rootPath && host.editor?.openFile(`${ws.rootPath.replace(/[\\/]+$/, '')}/${page.relPath}`)) })
      return el('li', {}, el('div', { class: 'name', text: page.title }), el('div', { class: 'role', text: `${page.relPath}${page.dotId ? ` · ${dotName(page.dotId)}` : ''}` }), el('div', { class: 'entry-actions' }, open))
    }))
    drawer.replaceChildren(head,
      el('h3', { text: `Scheduled work${schedule.running ? ' · running' : ''}` }),
      el('p', { class: 'hint', text: 'Runs while this panel is open: the Dot answers the prompt and the answer is saved as a page.' }),
      schedule.tasks.length ? tasks : el('div', { class: 'empty', text: 'No scheduled task yet.' }), form,
      el('h3', { text: 'Pages' }), pages.length ? pageList : el('div', { class: 'empty', text: 'No page yet. Save a Dot\'s answer with "Save as page".' }))
  }
  workButton.addEventListener('click', () => {
    drawer.hidden = !drawer.hidden
    clearInterval(drawerTimer)
    if (!drawer.hidden) { void renderDrawer(); drawerTimer = setInterval(() => { void renderDrawer() }, 10_000) }
  })
  function renderAll() { renderList(); renderTranscript(); renderStatus() }

  // --- actions --------------------------------------------------------------
  async function choose(id: string) {
    if (chat.busy()) { await host.ui?.notify('Wait for the running turn, or cancel it, before switching Dots.', 'warn'); return }
    await persist(selectDot(state, id))
    const dot = selected()
    transcript = dot ? [...await chat.select(dot)] : []
    renderAll()
  }
  // The panel's live session blocks scheduled runs (one session per extension),
  // so an idle conversation releases it; the next send resumes it unchanged.
  let lastTurnAt = now()
  const IDLE_RELEASE_MS = 120_000
  const idleTimer = setInterval(() => { if (chat.currentDotId() && !chat.busy() && now() - lastTurnAt > IDLE_RELEASE_MS) void chat.dispose() }, 15_000)
  async function send() {
    const dot = selected()
    const text = input.value
    if (!dot || !text.trim() || chat.busy()) return
    lastTurnAt = now()
    input.value = ''
    renderStatus()
    const ticking = setInterval(renderStatus, 500)
    try { await chat.send(dot, text) } catch (error) { await host.ui?.notify(error instanceof Error ? error.message : String(error), 'error') } finally { clearInterval(ticking); lastTurnAt = now(); renderStatus() }
  }
  async function edit(existing: Dot | null) {
    let profiles: ProfileOption[] = []
    try { const listed = await host.agent.profiles(); if ('profiles' in listed) profiles = listed.profiles.map(p => ({ id: p.id, name: p.name, role: p.role })) } catch { /* no profile list: the field stays free text */ }
    const draft = await openEditor(root, existing, profiles)
    if (!draft) return
    if (draft === 'delete' && existing) {
      if (chat.currentDotId() === existing.id) await chat.reset(existing)
      await persist(removeDot(state, existing.id))
      transcript = selected() ? [...await chat.select(selected()!)] : []
      renderAll()
      return
    }
    if (draft === 'delete') return
    const result = existing ? updateDot(state, existing.id, draft) : addDot(state, draft, now())
    if ('error' in result) { await host.ui?.notify(result.error, 'error'); return }
    await persist('state' in result ? result.state : result)
    if (!existing) { const dot = selected()!; transcript = [...await chat.select(dot)] }
    renderAll()
  }

  addButton.addEventListener('click', () => { void edit(null) })
  editButton.addEventListener('click', () => { const dot = selected(); if (dot) void edit(dot) })
  resetButton.addEventListener('click', () => { const dot = selected(); if (dot && !chat.busy()) void chat.reset(dot).then(() => { transcript = []; renderAll() }) })
  sendButton.addEventListener('click', () => { void send() })
  cancelButton.addEventListener('click', () => { void chat.cancel() })
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } })

  // Another panel of this extension, or a hand edit, changed the catalog.
  const unsubscribe = host.storage.onChange(key => {
    if (key && key !== STATE_KEY) return
    void host.storage.get(STATE_KEY).then(async raw => { state = sanitizeState(raw, now()); const dot = selected(); if (dot && !chat.busy()) transcript = [...await chat.select(dot)]; renderAll() })
  })

  const dot = selected()
  if (dot) transcript = [...await chat.select(dot)]
  renderAll()
  return { dispose: async () => { unsubscribe(); clearInterval(drawerTimer); clearInterval(idleTimer); await chat.dispose() } }
}

/** The review card before a page is written: title and content are the
 *  human's to change; nothing is saved until they confirm. */
function openPageReview(root: HTMLElement, draft: PageDraft): Promise<PageDraft | null> {
  return new Promise(resolve => {
    const title = el('input', { value: draft.title, maxLength: 120 })
    const content = el('textarea', { value: draft.content })
    const error = el('div', { class: 'error' })
    const save = el('button', { class: 'primary', text: 'Save page', type: 'submit' })
    const cancel = el('button', { text: 'Cancel', type: 'button' })
    const form = el('form', { class: 'page-review' }, el('label', { text: 'Title' }, title), el('label', { text: 'Content (Markdown)' }, content), error,
      el('div', { class: 'actions' }, el('div'), el('div', {}, cancel, save)))
    const overlay = el('div', { class: 'editor' }, form)
    const done = (result: PageDraft | null) => { overlay.remove(); resolve(result) }
    form.addEventListener('submit', event => {
      event.preventDefault()
      const next: PageDraft = { ...draft, title: title.value, content: content.value }
      const problem = validatePageDraft(next)
      if (problem) { error.textContent = problem; return }
      done(next)
    })
    cancel.addEventListener('click', () => done(null))
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') done(null) })
    root.style.position = 'relative'
    root.append(overlay)
    title.focus()
  })
}

/** The form for a new scheduled task. */
function taskForm(dots: readonly Dot[], submit: (draft: TaskDraft) => Promise<void>): HTMLFormElement {
  const dot = el('select', {}, ...dots.map(d => el('option', { value: d.id, text: d.name })))
  const title = el('input', { placeholder: 'Daily status', maxLength: 80 })
  const prompt = el('textarea', { placeholder: 'What the Dot does each time.' })
  const every = el('input', { type: 'number', value: '60', min: String(EVERY_MIN) })
  const error = el('div', { class: 'error' })
  const add = el('button', { class: 'primary small', text: 'Add task', type: 'submit' })
  const form = el('form', { class: 'task-form' }, el('label', { text: 'Dot' }, dot), el('label', { text: 'Title' }, title), el('label', { text: 'Prompt' }, prompt), el('label', { text: 'Every (minutes)' }, every), error, add)
  form.addEventListener('submit', event => {
    event.preventDefault()
    const draft: TaskDraft = { dotId: dot.value, title: title.value, prompt: prompt.value, everyMinutes: Number(every.value) }
    const problem = validateTaskDraft(draft)
    if (problem) { error.textContent = problem; return }
    error.textContent = ''
    void submit(draft).then(() => { title.value = ''; prompt.value = '' })
  })
  return form
}

interface ProfileOption { id: string; name: string; role: string }

/** A modal form for a new or existing Dot. Resolves with the draft, 'delete',
 *  or null when dismissed. `profiles` are the enabled agent profiles the Dot
 *  can run on; a profile the host no longer lists is kept selectable so an
 *  edit does not drop it silently. */
function openEditor(root: HTMLElement, existing: Dot | null, profiles: ProfileOption[]): Promise<DotDraft | 'delete' | null> {
  return new Promise(resolve => {
    const name = el('input', { value: existing?.name ?? '', maxLength: 60, placeholder: 'Reviewer' })
    const role = el('input', { value: existing?.role ?? '', maxLength: 160, placeholder: 'Reviews a change for correctness.' })
    const instructions = el('textarea', { value: existing?.instructions ?? '', placeholder: 'The standing instructions this Dot works under.' })
    const options = [...profiles]
    if (existing?.profileId && !options.some(p => p.id === existing.profileId)) options.push({ id: existing.profileId, name: existing.profileId, role: 'not enabled' })
    const profile = el('select', {}, el('option', { value: '', text: 'Agent default model' }),
      ...options.map(p => el('option', { value: p.id, text: `${p.name} (${p.role})` })))
    profile.value = existing?.profileId ?? ''
    const error = el('div', { class: 'error' })
    const save = el('button', { class: 'primary', text: existing ? 'Save' : 'Create', type: 'submit' })
    const cancel = el('button', { text: 'Cancel', type: 'button' })
    const remove = el('button', { class: 'danger', text: 'Delete', type: 'button' })
    const form = el('form', {},
      el('label', { text: 'Name' }, name), el('label', { text: 'Role' }, role), el('label', { text: 'Runs on' }, profile), el('label', { text: 'Instructions' }, instructions), error,
      el('div', { class: 'actions' }, el('div', {}, ...(existing ? [remove] : [])), el('div', {}, cancel, save)))
    const overlay = el('div', { class: 'editor' }, form)
    const done = (result: DotDraft | 'delete' | null) => { overlay.remove(); resolve(result) }
    form.addEventListener('submit', event => {
      event.preventDefault()
      const draft: DotDraft = { name: name.value, role: role.value, instructions: instructions.value, ...(profile.value ? { profileId: profile.value } : {}) }
      if (!draft.name.trim()) { error.textContent = 'A Dot needs a name.'; return }
      done(draft)
    })
    cancel.addEventListener('click', () => done(null))
    remove.addEventListener('click', () => done('delete'))
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') done(null) })
    root.style.position = 'relative'
    root.append(overlay)
    name.focus()
  })
}

if (typeof window !== 'undefined' && window.vibron && document.getElementById('root')) {
  void mount(document.getElementById('root')!, window.vibron)
}
