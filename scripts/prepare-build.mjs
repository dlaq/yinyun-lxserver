import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scripts = [
  'scripts/download-binary.js',
  'scripts/build-pwa-icons.mjs',
  'scripts/build-tailwind.mjs',
  'scripts/generate-pwa-precache.mjs',
  'scripts/update-build-hash.js',
]

for (const script of scripts) {
  const result = spawnSync(process.execPath, [path.join(rootDir, script)], {
    cwd: rootDir,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
