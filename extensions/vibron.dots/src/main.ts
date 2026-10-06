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
import {
  STATE_KEY, addDot, removeDot, sanitizeState, selectDot, updateDot,
  type Dot, type DotDraft, type DotsState, type TranscriptEntry,
} from './state'

export type PanelHost = ChatHost & { theme?: Pick<VibronHost['theme'], 'get'>; ui?: Pick<VibronHost['ui'], 'notify'>; storage: Pick<VibronHost['storage'], 'get' | 'set' | 'onChange'> }

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
  const transcriptView = el('div', { class: 'transcript' })
  const input = el('textarea', { placeholder: 'Ask the selected Dot… (Enter sends, Shift+Enter is a new line)', rows: 2 })
  const sendButton = el('button', { class: 'primary', text: 'Send' })
  const cancelButton = el('button', { text: 'Cancel', disabled: true })
  const shell = el('div', { class: 'dots' },
    el('aside', { class: 'dots-list' }, el('header', {}, el('span', { text: 'Dots' }), addButton), list),
    el('section', { class: 'dots-chat' },
      el('header', {}, title, status, editButton, resetButton),
      transcriptView,
      el('div', { class: 'composer' }, input, sendButton, cancelButton)))
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
    status.textContent = current === 'thinking' ? 'thinking…' : current === 'opening' ? 'opening session…' : current === 'error' ? 'last turn failed' : ''
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
    transcriptView.replaceChildren(...transcript.map(entry => { const node = el('div', { class: 'entry', text: entry.text }); node.dataset.role = entry.role; return node }))
    transcriptView.scrollTop = transcriptView.scrollHeight
    renderStatus()
  }
  function renderAll() { renderList(); renderTranscript(); renderStatus() }

  // --- actions --------------------------------------------------------------
  async function choose(id: string) {
    if (chat.busy()) { await host.ui?.notify('Wait for the running turn, or cancel it, before switching Dots.', 'warn'); return }
    await persist(selectDot(state, id))
    const dot = selected()
    transcript = dot ? [...await chat.select(dot)] : []
    renderAll()
  }
  async function send() {
    const dot = selected()
    const text = input.value
    if (!dot || !text.trim() || chat.busy()) return
    input.value = ''
    renderStatus()
    const ticking = setInterval(renderStatus, 500)
    try { await chat.send(dot, text) } catch (error) { await host.ui?.notify(error instanceof Error ? error.message : String(error), 'error') } finally { clearInterval(ticking); renderStatus() }
  }
  async function edit(existing: Dot | null) {
    const draft = await openEditor(root, existing)
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
  return { dispose: async () => { unsubscribe(); await chat.dispose() } }
}

/** A modal form for a new or existing Dot. Resolves with the draft, 'delete',
 *  or null when dismissed. */
function openEditor(root: HTMLElement, existing: Dot | null): Promise<DotDraft | 'delete' | null> {
  return new Promise(resolve => {
    const name = el('input', { value: existing?.name ?? '', maxLength: 60, placeholder: 'Reviewer' })
    const role = el('input', { value: existing?.role ?? '', maxLength: 160, placeholder: 'Reviews a change for correctness.' })
    const instructions = el('textarea', { value: existing?.instructions ?? '', placeholder: 'The standing instructions this Dot works under.' })
    const error = el('div', { class: 'error' })
    const save = el('button', { class: 'primary', text: existing ? 'Save' : 'Create', type: 'submit' })
    const cancel = el('button', { text: 'Cancel', type: 'button' })
    const remove = el('button', { class: 'danger', text: 'Delete', type: 'button' })
    const form = el('form', {},
      el('label', { text: 'Name' }, name), el('label', { text: 'Role' }, role), el('label', { text: 'Instructions' }, instructions), error,
      el('div', { class: 'actions' }, el('div', {}, ...(existing ? [remove] : [])), el('div', {}, cancel, save)))
    const overlay = el('div', { class: 'editor' }, form)
    const done = (result: DotDraft | 'delete' | null) => { overlay.remove(); resolve(result) }
    form.addEventListener('submit', event => {
      event.preventDefault()
      const draft: DotDraft = { name: name.value, role: role.value, instructions: instructions.value }
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
