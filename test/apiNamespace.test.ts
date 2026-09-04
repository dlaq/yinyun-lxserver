import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import path from 'node:path'
import { allowsPlayerQueryToken, classifyApiNamespace } from '../src/server/apiNamespace'

test('classifies each API v1 namespace without rewriting paths', () => {
  assert.equal(classifyApiNamespace('/api/v1/auth/login'), 'native')
  assert.equal(classifyApiNamespace('/api/v1/library/tracks'), 'native')
  assert.equal(classifyApiNamespace('/api/v1/admin/status'), 'admin')
  assert.equal(classifyApiNamespace('/api/v1/player/music/search'), 'player')
})

test('rejects only the removed unversioned API namespace', () => {
  assert.equal(classifyApiNamespace('/api'), 'legacy')
  assert.equal(classifyApiNamespace('/api/login'), 'legacy')
  assert.equal(classifyApiNamespace('/api-v1'), 'none')
  assert.equal(classifyApiNamespace('/rest/ping.view'), 'none')
})

test('allows query credentials only on read-only player media endpoints', () => {
  assert.equal(allowsPlayerQueryToken('/api/v1/player/music/cache/cover', 'GET'), true)
  assert.equal(allowsPlayerQueryToken('/api/v1/player/music/cache/file/dlaq/song.flac', 'GET'), true)
  assert.equal(allowsPlayerQueryToken('/api/v1/player/music/download', 'GET'), true)
  assert.equal(allowsPlayerQueryToken('/api/v1/player/music/cache/cover', 'POST'), false)
  assert.equal(allowsPlayerQueryToken('/api/v1/player/music/cache/file', 'GET'), false)
  assert.equal(allowsPlayerQueryToken('/api/v1/player/music/cache/remove', 'GET'), false)
  assert.equal(allowsPlayerQueryToken('/api/v1/player/user/settings', 'GET'), false)
})

test('server route implementation uses versioned paths directly', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/server/server.ts'), 'utf8')
  assert.doesNotMatch(source, /pathname\s*(?:===|startsWith\()\s*['"`]\/api\/(?!v1)/)
  assert.match(source, /pathname === '\/api\/v1\/admin\/login'/)
  assert.match(source, /pathname === '\/api\/v1\/player\/music\/search'/)
})

test('background lyric fetching accepts numeric platform song IDs', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/server/server.ts'), 'utf8')
  assert.match(source, /let songmid = String\(songInfo\.songmid \|\| songInfo\.songId \|\| songInfo\.id \|\| ''\)/)
})

test('deleting a playlist sync mapping cannot cascade into Songloft', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/server/apiV1.ts'), 'utf8')
  const mappingRouteStart = source.indexOf('const syncDeleteMatch = pathname.match')
  const nextRouteStart = source.indexOf("if (pathname === `${API_PREFIX}/auth/me`", mappingRouteStart)
  assert.notEqual(mappingRouteStart, -1)
  assert.notEqual(nextRouteStart, -1)
  const mappingRoute = source.slice(mappingRouteStart, nextRouteStart)
  assert.doesNotMatch(mappingRoute, /deletePlaylist\(/)
  assert.match(mappingRoute, /remoteDeleted:\s*false/)

  const explicitDeleteStart = source.indexOf('if (songloftPlaylistDeleteMatch')
  const explicitDeleteEnd = source.indexOf("if (pathname === `${API_PREFIX}/integration/songloft/scan`", explicitDeleteStart)
  const explicitDeleteRoute = source.slice(explicitDeleteStart, explicitDeleteEnd)
  assert.match(explicitDeleteRoute, /requireIntegrationAdmin\(req, deps\)/)
  assert.match(explicitDeleteRoute, /deletePlaylist\(playlistId\)/)
})
