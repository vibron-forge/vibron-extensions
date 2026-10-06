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
      profiles: vi.fn(async () => ({ profiles: [] })),
      open: vi.fn(async (opts?: { profileId?: string }) => { live = `/s/${store.size}.jsonl`; return { sessionId: live, model: opts?.profileId ? { provider: 'p', model: `${opts.profileId}-model` } : null } }),
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
    expect(f.host.agent.open).toHaveBeenCalledWith({ profileId: 'planner' })
    expect([...root.querySelectorAll('.entry')].map(e => [e.getAttribute('data-role'), e.querySelector('.text')?.textContent])).toEqual([['you', 'Plan it'], ['dot', 'ok: Plan it']])
    expect(root.querySelectorAll('.entry[data-role=dot] .save-page')).toHaveLength(1)
    expect(root.querySelector('.dots-chat .status')?.textContent).toBe('p/planner-model')
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
