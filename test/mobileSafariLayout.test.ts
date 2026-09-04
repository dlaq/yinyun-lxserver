import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const read = (relativePath: string): string => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')

test('player and admin opt into mobile safe-area layout', () => {
  for (const page of ['public/music/index.html', 'public/index.html']) {
    const html = read(page)
    assert.match(html, /name="viewport"[^>]+viewport-fit=cover/)
  }

  const playerCss = read('public/music/css/app.css')
  const playerHtml = read('public/music/index.html')
  assert.match(playerCss, /height:\s*100dvh/)
  assert.match(playerCss, /safe-area-inset-bottom/)
  assert.match(playerCss, /--mobile-player-reserve/)
  assert.match(playerCss, /font-size:\s*16px\s*!important/)
  assert.match(playerCss, /orientation:\s*landscape[\s\S]*?max-height:\s*520px[\s\S]*?pointer:\s*coarse/)
  assert.match(playerCss, /#player-footer\s*\{[\s\S]*?flex-direction:\s*row\s*!important/)
  assert.match(playerCss, /\.hot-search-container\s*\{[\s\S]*?padding-top:\s*\.5rem\s*!important/)
  assert.match(playerHtml, /id="songlist-detail-view"[\s\S]*?overflow-y-auto custom-scrollbar/)
  assert.match(playerHtml, /id="sl-detail-list"\s+class="p-2 space-y-1 pb-20"/)

  for (const viewId of ['view-songlist', 'view-my-playlists', 'view-leaderboard', 'view-localmusic']) {
    assert.match(
      playerHtml,
      new RegExp(`id="${viewId}"[\\s\\S]{0,260}?overflow-y-auto[\\s\\S]{0,120}?md:overflow-hidden`),
      `${viewId} must use the page as the mobile scroll container`,
    )
  }
  for (const listId of ['songlist-grid', 'my-playlists-grid', 'lb-songs-list', 'lm-list-container']) {
    assert.match(
      playerHtml,
      new RegExp(`id="${listId}"[\\s\\S]{0,260}?overflow-visible[\\s\\S]{0,160}?md:overflow-y-auto`),
      `${listId} must not create a nested mobile scroll box`,
    )
  }

  const adminCss = read('public/style.css')
  assert.match(adminCss, /height:\s*100dvh/)
  assert.match(adminCss, /safe-area-inset-top/)
  assert.match(adminCss, /safe-area-inset-bottom/)
})

test('touch-only Android and iOS layouts keep compact hot-search labels stable', () => {
  const playerApp = read('public/music/app.js')
  assert.match(playerApp, /matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/)
  assert.match(playerApp, /if \(!window\.matchMedia[\s\S]*?matches\) return/)
})

test('shared local-library songs retain a durable playlist identity', () => {
  const playerApp = read('public/music/app.js')
  assert.match(playerApp, /hasDurableLocalIdentity/)
  assert.match(playerApp, /\^local_\[a-f0-9\]\{32\}\$/)
  assert.match(playerApp, /song\?\._localFilename/)
  assert.match(playerApp, /song\?\._localOwner/)
})

test('the first authenticated local-library visit shows a loading state', () => {
  const localMusic = read('public/music/js/local_music.js')
  assert.match(localMusic, /hasLoadedOnce: false/)
  assert.match(localMusic, /fetchData\(window\.LocalMusicManager\.hasLoadedOnce\)/)
  assert.match(localMusic, /if \(result\.success\) \{\s*this\.hasLoadedOnce = true/)
})

test('lazy local covers refresh an expired user token once', () => {
  const playerApp = read('public/music/app.js')
  assert.match(playerApp, /url\.pathname === '\/api\/v1\/player\/music\/cache\/cover'/)
  assert.match(playerApp, /img\.dataset\.authRetry !== 'true'/)
  assert.match(playerApp, /ensureUserAuthToken\(\{ force: true \}\)/)
  assert.match(playerApp, /retryUrl\.searchParams\.set\('token', token\)/)
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
  assert.match(soundEffects, /audioContext\?\.audioWorklet/)
  assert.match(soundEffects, /typeof window\.AudioWorkletNode === 'function'/)
  assert.match(soundEffects, /AudioWorklet unavailable; pitch shifting disabled/)
  assert.match(playerApp, /window\._audioEngineUnavailable = true/)
})

test('an empty GitHub release collection is handled as a normal state', () => {
  const notifications = read('public/js/notification-engine.js')
  assert.match(notifications, /releases\?per_page=1/)
  assert.match(notifications, /payload\[0\] \|\| \{ noRelease: true \}/)
  assert.match(notifications, /if \(release\.noRelease\)/)
})

test('production pages use precompiled Tailwind styles instead of the browser compiler', () => {
  const playerHtml = read('public/music/index.html')
  const adminHtml = read('public/index.html')
  const playerWorker = read('public/music/sw.js')
  const adminWorker = read('public/sw.js')
  const playerStyles = read('public/music/css/tailwind.generated.css')
  const adminStyles = read('public/tailwind.generated.css')

  for (const source of [playerHtml, adminHtml, playerWorker, adminWorker]) {
    assert.doesNotMatch(source, /tailwindcss\.js/)
  }
  assert.match(playerHtml, /tailwind\.generated\.css/)
  assert.match(adminHtml, /tailwind\.generated\.css/)
  assert.match(playerWorker, /tailwind\.generated\.css/)
  assert.match(adminWorker, /tailwind\.generated\.css/)
  assert.match(playerStyles, /@media \(min-width:1025px\)/)
  assert.match(playerStyles, /var\(--c-500\)/)
  assert.match(adminStyles, /\.hidden\{display:none\}/)
  assert.doesNotMatch(adminStyles, /\*,:after,:before\{box-sizing:border-box/)
})

test('lyric cache misses are normal responses and download tasks read the cache contract', () => {
  const server = read('src/server/server.ts')
  const downloadManager = read('public/music/js/download_manager.js')

  assert.match(server, /success: false, cached: false, data: null/)
  assert.match(server, /'Cache-Control': 'no-store'/)
  assert.doesNotMatch(server, /writeHead\(404[\s\S]{0,160}Not found in cache/)
  assert.match(downloadManager, /payload\?\.success === true[\s\S]*?payload\?\.cached !== false[\s\S]*?payload\?\.data/)
})
