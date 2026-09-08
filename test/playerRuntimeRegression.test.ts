import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const app = fs.readFileSync('public/music/app.js', 'utf8')
function section(start: string, end: string) {
  const offset = app.indexOf(start)
  assert.ok(offset >= 0, start)
  return app.slice(offset, app.indexOf(end, offset + start.length))
}

test('media token refresh cannot attach account credentials to third-party URLs', () => {
  const sandbox = vm.createContext({
    URL, console, window: { location: { origin: 'https://music.example.test' } },
    getUserAuthHeaders: () => ({ 'x-user-token': 'private-test-token' }),
  })
  vm.runInContext(section('function updateLocalPlaybackToken(', '\n/**'), sandbox)
  for (const url of ['https://other.test/audio.flac', '//other.test/audio.flac', 'https://music.example.test.evil.test/a', '/api/v1/integration/songloft/playlists']) {
    assert.equal(sandbox.updateLocalPlaybackToken(url), url)
  }
  const refreshed = new URL(sandbox.updateLocalPlaybackToken('/api/v1/player/music/cache/file/user/a.flac?token=expired&folder=music'), 'https://music.example.test')
  assert.equal(refreshed.searchParams.get('token'), 'private-test-token')
  assert.equal(refreshed.searchParams.get('folder'), 'music')
})

test('local playlist retry never submits a local file to an online source', async () => {
  const sandbox = vm.createContext({
    URL, URLSearchParams, console,
    window: { location: { origin: 'https://music.example.test' } },
    normalizeLocalPlaybackSong: (song: unknown) => song,
    cleanSongData: (song: unknown) => song,
    getPlaybackCacheKey: () => 'isolated-test-cache',
    ensureLocalPlaybackAuth: async () => true,
    ensureOnlineSourceAuth: async () => { throw new Error('local file entered online resolver') },
    updateLocalPlaybackToken: (url: string) => url,
    applyAutoProxy: async (url: string) => url,
  })
  vm.runInContext(section('async function fetchSongUrl(', '\nfunction getNextIndex('), sandbox)
  const song = { id: 'local-one', source: 'local', isLocal: true, url: '/api/v1/player/music/cache/file/user/a.flac' }
  for (const retry of [false, true, 'local_retry']) {
    const result = await sandbox.fetchSongUrl(song, 'flac', retry, true)
    assert.equal(result.url, song.url)
    assert.equal(result.sourceType, 'server_cache')
  }
})

test('a failed local media element retries once and then stops with an actionable error', async () => {
  const retries: unknown[][] = [], errors: string[] = []
  const audio = {
    currentTime: 0, addEventListener() {}, removeEventListener() {}, pause() {}, removeAttribute() {}, load() {},
  }
  const sandbox = vm.createContext({
    console, audio, activePlaybackGuard: null, currentRecoveryState: null,
    PLAYBACK_START_TIMEOUT: 1000, setTimeout: () => 1, clearTimeout() {},
    getPlaybackCacheKey: () => 'test-cache', localStorage: { removeItem() {} },
    prefetchManager: { cache: new Map() },
    playSong: async (...args: unknown[]) => { retries.push(args) },
    showInfo() {}, showError: (message: string) => errors.push(message), setPlayerStatus() {}, updatePlayButton() {},
  })
  vm.runInContext(section('function createPlaybackGuard(', '\n// 获取来源类型'), sandbox)
  const options = { requestId: 1, song: { id: 'a', isLocal: true }, index: 0, quality: 'flac', sourceType: 'server_cache', noPlay: false }
  await sandbox.createPlaybackGuard(options).fail(new Error('media failed'))
  assert.equal(retries.length, 1)
  assert.equal(retries[0][4], 'local_retry')
  await sandbox.createPlaybackGuard({ ...options, isRetry: 'local_retry' }).fail(new Error('still failed'))
  assert.equal(retries.length, 1, 'must not loop into the online resolver or retry indefinitely')
  assert.match(errors[0], /文件.*格式.*网络/)
})

test('URL probe cancels a response body even when the server ignores Range', async () => {
  let cancelled = 0
  const timers = new Set<unknown>()
  const sandbox = vm.createContext({
    URL, AbortController, console,
    window: { location: { host: 'music.example.test', origin: 'https://music.example.test' } },
    setTimeout: () => { const timer = {}; timers.add(timer); return timer },
    clearTimeout: (timer: unknown) => timers.delete(timer),
    fetch: async () => ({ ok: true, body: { cancel: async () => { cancelled++ } } }),
  })
  vm.runInContext(section('async function probeUrl(', '\nconst prefetchManager'), sandbox)
  assert.equal(await sandbox.probeUrl('https://media.example.test/song.flac'), true)
  assert.equal(cancelled, 1)
  assert.equal(timers.size, 0)
  sandbox.fetch = async () => { throw new Error('network unavailable') }
  assert.equal(await sandbox.probeUrl('https://media.example.test/song.flac'), false)
  assert.equal(timers.size, 0)
})
