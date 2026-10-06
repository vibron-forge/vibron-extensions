// Maps Vibron's theme (`vibron.theme.get()`) onto the panel's few CSS tokens.
// The app palette is a CSS-variable map keyed without the leading `--`; the
// names used here are the ones Vibron's own chrome defines, with fallbacks so
// the panel stays readable if a theme omits one.
import type { VibronHostTheme } from './vibron-host'

const TOKENS: Array<[token: string, keys: string[], dark: string, light: string]> = [
  ['--dots-bg', ['bg-panel', 'bg', 'background'], '#1b1b1f', '#ffffff'],
  ['--dots-bg-2', ['bg-sidebar', 'bg-secondary', 'bg-elevated'], '#232328', '#f4f4f6'],
  ['--dots-fg', ['fg', 'text', 'foreground'], '#e6e6e9', '#1c1c20'],
  ['--dots-fg-2', ['fg-muted', 'text-muted', 'muted'], '#9a9aa3', '#6b6b74'],
  ['--dots-border', ['border', 'border-color'], '#34343b', '#dcdce1'],
  ['--dots-accent', ['accent', 'primary'], '#7c9cff', '#3b63f0'],
  ['--dots-danger', ['danger', 'error'], '#ff7b7b', '#d13a3a'],
]

export function applyTheme(theme: VibronHostTheme | null): void {
  const style = document.documentElement.style
  const type = theme?.type ?? 'dark'
  document.documentElement.dataset.theme = type
  for (const [token, keys, dark, light] of TOKENS) {
    const found = keys.map(key => theme?.app[key]).find(value => typeof value === 'string' && value.length > 0)
    style.setProperty(token, found ?? (type === 'dark' ? dark : light))
  }
}
