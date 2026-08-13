import assert from 'node:assert/strict'
import test from 'node:test'
import { SongloftClient, SubsonicClient } from '../src/server/songloftClient'

test('Songloft client logs in once and sends bearer auth to library calls', async () => {
  const requests: Array<{ url: string; authorization?: string }> = []
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, authorization: new Headers(init?.headers).get('Authorization') || undefined })
    if (url.endsWith('/auth/login')) return new Response(JSON.stringify({ access_token: 'token-1' }), { status: 200 })
    if (url.includes('/songs?')) return new Response(JSON.stringify({ songs: [{ id: 7, title: 'Song', artist: 'Artist', album: 'Album', duration: 180, file_path: '/app/music/Artist/Song.flac' }], total: 1 }), { status: 200 })
    if (url.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const client = new SongloftClient({ baseUrl: 'http://songloft/api/v1', username: 'u', password: 'p', fetchImpl })
  assert.equal(client.configured, true)
  assert.equal((await client.listAllSongs())[0].relativePath, 'Artist/Song.flac')
  assert.equal(requests.filter(item => item.url.endsWith('/auth/login')).length, 1)
  assert.equal(requests.find(item => item.url.includes('/songs?'))?.authorization, 'Bearer token-1')
})

test('Subsonic client emits token authentication and maps playlist entries', async () => {
  let requestUrl = ''
  const fetchImpl = (async (input: string | URL) => {
    requestUrl = String(input)
    return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', searchResult3: { song: [{ id: 's1', title: 'Song', artist: 'Artist', path: '/music/Artist/Song.flac' }] } } }), { status: 200 })
  }) as typeof fetch
  const client = new SubsonicClient({ baseUrl: 'http://songloft/subsonic/rest', username: 'u', password: 'p', fetchImpl })
  assert.deepEqual((await client.searchSongs('Song'))[0].id, 's1')
  const url = new URL(requestUrl)
  assert.equal(url.searchParams.get('u'), 'u')
  assert.match(url.searchParams.get('t') || '', /^[0-9a-f]{32}$/)
  assert.match(url.searchParams.get('s') || '', /^[0-9a-f]{16}$/)
})
