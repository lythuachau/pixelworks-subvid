/**
 * Start the Astro dev server without the Cloudflare workerd runtime.
 * Use when `pnpm dev` fails with: internal error; reference = …
 */
process.env.LOCAL_STATIC = '1'

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Prefer local package binary so Windows shells without PATH entry still work.
const astroCli = fileURLToPath(new URL('../node_modules/astro/bin/astro.mjs', import.meta.url))
const args = process.argv.slice(2).filter((arg) => arg !== '--')
const child = spawn(process.execPath, [astroCli, 'dev', ...args], {
  stdio: 'inherit',
  shell: false,
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
