// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount, type PanelHost } from './main'
import { STATE_KEY } from './state'

function fakeHost() {
  const store = new Map<string, unknown>()
  const listeners = new Set<(key?: string) => void>()
  let live: string | null = null
  const host: PanelHost = {
    theme: { get: async () => ({ id: 'x', type: 'light' as const, app: { accent: '#123456' }, terminal: {} }) },
    ui: { notify: vi.fn(async () => {}) },
    storage: {
      get: async key => store.get(key),
      set: async (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))) },
      onChange: cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    },
    agent: {
      open: vi.fn(async () => { live = `/s/${store.size}.jsonl`; return { sessionId: live } }),
      send: vi.fn(async (_id: string, prompt: string) => ({ text: `ok: ${prompt.split('\n').at(-1)}`, message: null })),
      dispose: vi.fn(async () => { live = null }),
      cancel: vi.fn(async () => {}),
    },
  }
  return { host, store, external: (key?: string) => { for (const cb of listeners) cb(key) } }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('panel', () => {
  it('renders the seeded Dots, sends a turn with Enter, and shows the answer', async () => {
    const f = fakeHost()
    const root = document.createElement('div')
    document.body.append(root)
    const panel = await mount(root, f.host, () => 42)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.getPropertyValue('--dots-accent')).toBe('#123456')
    const items = [...root.querySelectorAll('li')]
    expect(items.map(li => li.querySelector('.name')?.textContent)).toEqual(['Planner', 'Coding', 'Reviewer', 'Researcher'])
    expect(items[0]?.getAttribute('aria-selected')).toBe('true')
    expect(root.querySelector('.dots-chat .title')?.textContent).toBe('Planner')

    const input = root.querySelector('textarea')!
    input.value = 'Plan it'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush(); await flush(); await flush()
    expect(f.host.agent.open).toHaveBeenCalledTimes(1)
    expect([...root.querySelectorAll('.entry')].map(e => [e.getAttribute('data-role'), e.textContent])).toEqual([['you', 'Plan it'], ['dot', 'ok: Plan it']])
    expect(f.store.get(STATE_KEY)).toMatchObject({ version: 1, selectedId: 'planner' })

    // Selecting another Dot shows its own (empty) transcript and disposes the live session.
    items[1]!.click()
    await flush(); await flush()
    expect(root.querySelector('.dots-chat .title')?.textContent).toBe('Coding')
    expect(root.querySelector('.empty')?.textContent).toContain('Coding works under its instructions')
    expect(f.host.agent.dispose).toHaveBeenCalledTimes(1)

    // An external edit of the catalog re-renders the list.
    f.store.set(STATE_KEY, { version: 1, selectedId: 'solo', dots: [{ id: 'solo', name: 'Solo', role: 'Only one.', instructions: '' }] })
    f.external(STATE_KEY)
    await flush(); await flush()
    expect([...root.querySelectorAll('li .name')].map(e => e.textContent)).toEqual(['Solo'])
    await panel.dispose()
  })
})
