import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const read = (relativePath: string): string => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')

test('player and admin opt into iPhone safe-area layout', () => {
  for (const page of ['public/music/index.html', 'public/index.html']) {
    const html = read(page)
    assert.match(html, /name="viewport"[^>]+viewport-fit=cover/)
  }

  const playerCss = read('public/music/css/app.css')
  assert.match(playerCss, /height:\s*100dvh/)
  assert.match(playerCss, /safe-area-inset-bottom/)
  assert.match(playerCss, /--mobile-player-reserve/)
  assert.match(playerCss, /font-size:\s*16px\s*!important/)

  const adminCss = read('public/style.css')
  assert.match(adminCss, /height:\s*100dvh/)
  assert.match(adminCss, /safe-area-inset-top/)
  assert.match(adminCss, /safe-area-inset-bottom/)
})

test('shared local-library songs retain a durable playlist identity', () => {
  const playerApp = read('public/music/app.js')
  assert.match(playerApp, /hasDurableLocalIdentity/)
  assert.match(playerApp, /\^local_\[a-f0-9\]\{32\}\$/)
  assert.match(playerApp, /song\?\._localFilename/)
  assert.match(playerApp, /song\?\._localOwner/)
})
