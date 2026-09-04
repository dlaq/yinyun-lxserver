import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  getNetworkPlaylistSongs,
  networkPlaylistsAreEqual,
  parseNetworkPlaylistInterval,
  pruneNetworkPlaylistState,
} from '../src/server/networkPlaylistMonitorUtils'

test('network playlist monitor parses supported intervals and clamps short values', () => {
  assert.equal(parseNetworkPlaylistInterval('6h'), 6 * 60 * 60 * 1000)
  assert.equal(parseNetworkPlaylistInterval('30s'), 30 * 1000)
  assert.equal(parseNetworkPlaylistInterval('off'), 0)
  assert.equal(parseNetworkPlaylistInterval('invalid'), 6 * 60 * 60 * 1000)
})

test('network playlist monitor compares source and song ids in order', () => {
  const list = [{ source: 'tx', songmid: '1' }, { source: 'tx', songmid: '2' }]
  assert.equal(networkPlaylistsAreEqual(list, [{ source: 'tx', id: '1' }, { source: 'tx', id: '2' }]), true)
  assert.equal(networkPlaylistsAreEqual(list, [{ source: 'wy', songmid: '1' }, { source: 'tx', songmid: '2' }]), false)
  assert.equal(networkPlaylistsAreEqual(list, [...list].reverse()), false)
})

test('network playlist monitor rejects malformed responses instead of treating them as empty', () => {
  assert.deepEqual(getNetworkPlaylistSongs({ list: [] }), [])
  assert.throws(() => getNetworkPlaylistSongs({}), /incomplete/)
  assert.throws(() => getNetworkPlaylistSongs({ list: null }), /incomplete/)
  assert.throws(() => getNetworkPlaylistSongs(null), /incomplete/)
})

test('network playlist monitor prunes state for deleted playlists', () => {
  const state = {
    keep: { changed: false },
    deleted: { changed: true },
  }
  assert.deepEqual(pruneNetworkPlaylistState(state, ['keep']), { keep: { changed: false } })
  assert.deepEqual(state, {
    keep: { changed: false },
    deleted: { changed: true },
  })
})

test('network playlist monitor clears both recurring and pending initial timers for a removed user', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/server/networkPlaylistMonitor.ts'), 'utf8')
  assert.match(source, /private readonly initialChecks = new Map/)
  assert.match(source, /clearTimeout\(initialCheck\)/)
  assert.match(source, /new Set\(\[\.\.\.this\.timers\.keys\(\), \.\.\.this\.initialChecks\.keys\(\)\]\)/)
  assert.match(source, /scheduled check failed/)
})
