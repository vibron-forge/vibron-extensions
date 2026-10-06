// dist/index.html is served by Vibron's proxy at the route root (/ext/<token>/)
// although it lives in dist/, so the entry refs Vite emits as `./app.js` must
// become `dist/app.js`. Everything downstream is import.meta.url-relative.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexPath = path.join(extDir, 'dist', 'index.html')
const html = await readFile(indexPath, 'utf8')
await writeFile(indexPath, html.replace(/\b(src|href)="\.\//g, '$1="dist/'))
console.log('[postbuild] rewrote entry refs in dist/index.html')
