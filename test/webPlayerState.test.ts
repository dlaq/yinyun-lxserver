import assert from 'node:assert/strict'
import test from 'node:test'

const { buildSingleTrackPlayback, isSongCollected, playbackCacheKey } = require('../public/music/js/web_player_state.js')

test('URL and prefetch keys isolate users, platforms, qualities and local owners', () => {
  const song = { id: 'same-id', source: 'tx' }
  const keys = [
    playbackCacheKey('alice', song, 'flac'),
    playbackCacheKey('bob', song, 'flac'),
    playbackCacheKey('alice', { ...song, source: 'wy' }, 'flac'),
    playbackCacheKey('alice', song, '128k'),
    playbackCacheKey('alice', { ...song, libraryOwner: 'bob' }, 'flac'),
  ]
  assert.equal(new Set(keys).size, keys.length)
  assert.equal(playbackCacheKey(' Alice ', song, 'flac'), keys[0])
})

test('single playlist playback never falls back to an unrelated default list', () => {
  const list = [{ id: 'one' }, { id: 'two' }]
  assert.deepEqual(buildSingleTrackPlayback(list, 1, false), { list: [{ id: 'two' }], index: 0 })
  assert.deepEqual(buildSingleTrackPlayback(list, 1, true), { list, index: 1 })
})

test('favorite state includes both the love list and user playlists', () => {
  const data = {
    loveList: [{ id: 'love-song' }],
    userList: [{ id: 'playlist', list: [{ id: 'playlist-song' }] }],
  }
  assert.equal(isSongCollected(data, 'love-song'), true)
  assert.equal(isSongCollected(data, 'playlist-song'), true)
  assert.equal(isSongCollected(data, 'missing'), false)
})
