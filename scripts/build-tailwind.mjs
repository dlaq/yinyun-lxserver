import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tailwindCli = require.resolve('tailwindcss/lib/cli.js')
const inputPath = path.join(rootDir, 'styles', 'tailwind.css')

const builds = [
  {
    name: 'player',
    config: path.join(rootDir, 'tailwind.player.config.cjs'),
    output: path.join(rootDir, 'public', 'music', 'css', 'tailwind.generated.css'),
  },
  {
    name: 'admin',
    config: path.join(rootDir, 'tailwind.admin.config.cjs'),
    output: path.join(rootDir, 'public', 'tailwind.generated.css'),
  },
]

for (const build of builds) {
  console.log(`[Tailwind] Building ${build.name} stylesheet...`)
  const result = spawnSync(process.execPath, [
    tailwindCli,
    '--config', build.config,
    '--input', inputPath,
    '--output', build.output,
    '--minify',
  ], {
    cwd: rootDir,
    env: { ...process.env, BROWSERSLIST_IGNORE_OLD_DATA: 'true' },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
