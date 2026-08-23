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

test('pre-login initialization does not mutate cache config or call protected cache stats', () => {
  const playerApp = read('public/music/app.js')
  assert.doesNotMatch(playerApp, /Initial Sync for Server Cache Config/)
  assert.match(playerApp, /Server cache configuration is persisted only after an explicit setting/)
  assert.match(playerApp, /if \(!isUserLoggedIn\(\)\) \{[\s\S]*?登录后查看/)
  assert.match(playerApp, /response\.status === 401[\s\S]*?ensureUserAuthToken\(\{ force: true \}\)/)
})

test('sound effects disable cleanly when Web Audio is unavailable', () => {
  const soundEffects = read('public/music/js/sound-effects.js')
  const playerApp = read('public/music/app.js')
  assert.match(soundEffects, /typeof AudioContextConstructor !== 'function'/)
  assert.match(soundEffects, /sound effects disabled/)
  assert.match(playerApp, /window\._audioEngineUnavailable = true/)
})

test('an empty GitHub release collection is handled as a normal state', () => {
  const notifications = read('public/js/notification-engine.js')
  assert.match(notifications, /releases\?per_page=1/)
  assert.match(notifications, /payload\[0\] \|\| \{ noRelease: true \}/)
  assert.match(notifications, /if \(release\.noRelease\)/)
})
