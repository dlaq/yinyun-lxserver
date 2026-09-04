import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const root = process.cwd()
const read = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf8')

const readPrecacheUrls = (relativePath: string): string[] => {
  const source = read(relativePath)
  const block = source.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/)?.[1]
  assert.ok(block, `${relativePath} must declare PRECACHE_URLS`)
  return [...block.matchAll(/["']([^"']+)["']/g)].map(match => match[1])
}

const resolvePlayerAsset = (url: string): string => {
  if (url === '/') return 'public/music/index.html'
  if (url === '/manifest.json') return 'public/music/manifest.json'
  if (url.startsWith('/_player/')) return `public/music/${url.slice('/_player/'.length)}`
  if (url.startsWith('/admin/')) return `public/${url.slice('/admin/'.length)}`
  return `public/${url.slice(1)}`
}

const resolveAdminAsset = (url: string): string => {
  if (url === './' || url === './index.html') return 'public/index.html'
  if (url.startsWith('./')) return `public/${url.slice(2)}`
  if (url.startsWith('/_player/')) return `public/music/${url.slice('/_player/'.length)}`
  return `public/${url.slice(1)}`
}

const runActivate = async (relativePath: string, existingCaches: string[]) => {
  const listeners = new Map<string, (event: any) => void>()
  const deleted: string[] = []
  let claimed = false
  const context = {
    URL,
    Request,
    Response,
    fetch: async () => new Response('ok'),
    caches: {
      keys: async () => existingCaches,
      delete: async (name: string) => {
        deleted.push(name)
        return true
      },
      open: async () => ({ put: async () => undefined }),
      match: async () => undefined,
    },
    self: {
      location: { origin: 'https://music.example.test' },
      registration: { scope: relativePath.includes('music/sw') ? 'https://music.example.test/' : 'https://music.example.test/admin/' },
      clients: {
        claim: async () => {
          claimed = true
        },
      },
      skipWaiting: async () => undefined,
      addEventListener: (type: string, handler: (event: any) => void) => listeners.set(type, handler),
    },
  }

  vm.runInNewContext(read(relativePath), context, { filename: relativePath })
  const activate = listeners.get('activate')
  assert.ok(activate, `${relativePath} must register an activate handler`)
  let activation: Promise<unknown> | undefined
  activate({ waitUntil: (promise: Promise<unknown>) => { activation = promise } })
  assert.ok(activation, `${relativePath} activate handler must use waitUntil`)
  await activation
  return { deleted, claimed }
}

test('PWA manifests provide portable standalone identity and platform icons', () => {
  const playerManifest = JSON.parse(read('public/music/manifest.json'))
  const adminManifest = JSON.parse(read('public/manifest.json'))
  const playerHtml = read('public/music/index.html')

  assert.equal(playerManifest.id, '/')
  assert.equal(playerManifest.start_url, '/')
  assert.equal(playerManifest.scope, '/')
  assert.equal(playerManifest.display, 'standalone')
  assert.equal(adminManifest.start_url, './')
  assert.equal(adminManifest.scope, './')
  assert.ok(playerManifest.icons.some((icon: any) => icon.sizes === '192x192' && icon.type === 'image/png'))
  assert.ok(playerManifest.icons.some((icon: any) => icon.sizes === '512x512' && icon.type === 'image/png'))
  assert.ok(playerManifest.icons.some((icon: any) => icon.purpose === 'maskable'))
  assert.match(playerHtml, /rel="apple-touch-icon"[^>]+icon-180\.png/)
  assert.match(playerHtml, /apple-mobile-web-app-capable/)
  assert.doesNotMatch(JSON.stringify(playerManifest), /music\.xdkkk\.com/)
})

test('every player and admin precache URL resolves to a committed local asset', () => {
  for (const url of readPrecacheUrls('public/music/sw.js')) {
    const resolved = resolvePlayerAsset(url)
    assert.ok(fs.existsSync(path.join(root, resolved)), `missing player precache asset: ${url} -> ${resolved}`)
  }
  for (const url of readPrecacheUrls('public/sw.js')) {
    const resolved = resolveAdminAsset(url)
    assert.ok(fs.existsSync(path.join(root, resolved)), `missing admin precache asset: ${url} -> ${resolved}`)
  }
})

test('player and admin service workers never delete each other caches', async () => {
  const playerHash = read('public/music/sw.js').match(/const BUILD_HASH = '([^']+)'/)?.[1]
  const adminHash = read('public/sw.js').match(/const BUILD_HASH = '([^']+)'/)?.[1]
  assert.ok(playerHash)
  assert.ok(adminHash)
  const player = await runActivate('public/music/sw.js', [
    `yinyun-player-${playerHash}-precache`,
    `yinyun-player-${playerHash}-runtime`,
    'yinyun-player-old-precache',
    'yinyun-admin-old-precache',
    'unrelated-cache',
  ])
  assert.deepEqual(player.deleted, ['yinyun-player-old-precache'])
  assert.equal(player.claimed, true)

  const admin = await runActivate('public/sw.js', [
    `yinyun-admin-${adminHash}-precache`,
    `yinyun-admin-${adminHash}-runtime`,
    'yinyun-admin-old-precache',
    'yinyun-player-old-precache',
    'unrelated-cache',
  ])
  assert.deepEqual(admin.deleted, ['yinyun-admin-old-precache'])
  assert.equal(admin.claimed, true)
})

test('PWA caching bypasses private and large responses and updates per build', () => {
  const playerWorker = read('public/music/sw.js')
  const adminWorker = read('public/sw.js')
  const playerPwa = read('public/music/js/pwa.js')
  const playerApp = read('public/music/app.js')
  const adminHtml = read('public/index.html')
  const buildHashScript = read('scripts/update-build-hash.js')
  const prepareBuild = read('scripts/prepare-build.mjs')
  const generatePrecache = read('scripts/generate-pwa-precache.mjs')

  for (const worker of [playerWorker, adminWorker]) {
    assert.match(worker, /const BUILD_HASH = '[^']+';/)
    assert.match(worker, /startsWith\('\/api\/'\)/)
    assert.match(worker, /startsWith\('\/rest\/'\)/)
    assert.match(worker, /request\.headers\.has\('range'\)/)
    assert.match(worker, /const CONFIG_PATH = '\/js\/config\.js'/)
    assert.match(worker, /CONFIG_CACHE_KEY/)
    assert.match(worker, /networkFirstConfig/)
    assert.match(worker, /fetch\(CONFIG_PATH, \{ cache: 'no-store'/)
    assert.match(worker, /networkFirstAsset/)
    assert.match(worker, /cacheFirstHashedAsset/)
    assert.match(worker, /cacheName\.startsWith\(CACHE_PREFIX\)/)
    assert.doesNotMatch(worker, /const cached = await caches\.match\(request/)
    const installBlock = worker.match(/self\.addEventListener\('install'[\s\S]*?self\.addEventListener\('fetch'/)?.[0] || ''
    assert.doesNotMatch(installBlock, /skipWaiting/)
    assert.match(worker, /event\.data\?\.type === 'SKIP_WAITING'/)
  }

  assert.match(playerPwa, /updateViaCache: 'none'/)
  assert.match(playerPwa, /CLEAR_RUNTIME_CACHES/)
  assert.match(playerPwa, /controllerchange/)
  assert.match(playerPwa, /isPlaybackIdle/)
  assert.match(playerPwa, /offerPendingUpdate/)
  assert.match(playerPwa, /window\.confirm/)
  assert.match(playerPwa, /pwa-offline-indicator/)
  assert.match(playerPwa, /const isDefaultHttpPort = location\.port === '' \|\| location\.port === '80'/)
  assert.match(playerPwa, /location\.protocol === 'http:' && isDefaultHttpPort/)
  assert.match(playerPwa, /target\.protocol = 'https:'/)
  assert.match(playerPwa, /workerUrl\.searchParams\.set\('v', window\.CONFIG\.buildHash\)/)
  assert.match(adminHtml, /workerUrl\.searchParams\.set\('v', window\.CONFIG\.buildHash\)/)
  assert.match(playerPwa, /currentRegistration\?\.active\?\.scriptURL \|\| '\/sw\.js'/)
  assert.match(adminHtml, /currentRegistration\?\.scope === adminScope/)
  assert.match(adminHtml, /currentAdminScript \|\| 'sw\.js'/)
  assert.match(adminHtml, /scope: adminScope, updateViaCache: 'none'/)
  assert.match(playerWorker, /fetchUrl\.searchParams\.set\('__pwa', BUILD_HASH\)/)
  assert.match(adminWorker, /fetchUrl\.searchParams\.set\('__pwa', BUILD_HASH\)/)
  assert.match(playerPwa, /const checkPwaUpdates = async/)
  assert.doesNotMatch(playerPwa, /const checkForUpdates = async/)
  assert.doesNotMatch(playerApp, /Promise\.all\(keys\.map\(k => caches\.delete\(k\)\)\)/)
  assert.match(playerApp, /key\.startsWith\('yinyun-player-'\) && key\.endsWith\('-runtime'\)/)
  assert.match(playerApp, /function sanitizeCachedPlaylistArtwork/)
  assert.match(playerApp, /function isSignedLocalArtwork/)
  assert.match(buildHashScript, /public', 'music', 'sw\.js'/)
  assert.match(buildHashScript, /public', 'sw\.js'/)
  assert.match(generatePrecache, /PRECACHE:START/)
  assert.match(generatePrecache, /public\/music\/sw\.js|public', 'music', 'sw\.js/)
  assert.ok(prepareBuild.indexOf('generate-pwa-precache.mjs') < prepareBuild.indexOf('update-build-hash.js'))
  assert.ok(prepareBuild.indexOf('build-pwa-icons.mjs') < prepareBuild.indexOf('update-build-hash.js'))
  assert.ok(prepareBuild.indexOf('build-tailwind.mjs') < prepareBuild.indexOf('update-build-hash.js'))
})
