import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendSongsStable,
  assertPlaylistData,
  PlaylistInvariantError,
  repairHistoricalDuplicatePlaylists,
} from '../src/server/playlistInvariants'

const song = (id: string, extra: Record<string, unknown> = {}) => ({ id, source: 'wy', name: id, singer: 'artist', ...extra }) as any
const playlist = (id: string, coverSongId?: string) => ({ id, name: id, locationUpdateTime: 1, coverSongId, list: [song(`${id}-1`)] })

test('playlist imports reject duplicate IDs and malformed sort/song data', () => {
  const duplicate = { defaultList: [], loveList: [], userList: [playlist('one'), playlist('one')] }
  assert.throws(() => assertPlaylistData(duplicate), (error: any) => error instanceof PlaylistInvariantError && error.code === 'duplicate_playlist_id')
  assert.throws(
    () => assertPlaylistData({ defaultList: [], loveList: [], userList: [{ id: 'bad', name: 'bad', list: [{}] }] }),
    (error: any) => error?.code === 'missing_song_id',
  )
})
test('historical repair merges identical and cover-only duplicates without changing songs', () => {
  const data = {
    defaultList: [song('default')], loveList: [],
    userList: [playlist('same'), playlist('same'), playlist('cover'), playlist('cover', 'cover-1')],
  }
  const { repaired, report } = repairHistoricalDuplicatePlaylists(data)
  assert.equal(report.inputPlaylistCount, 4)
  assert.equal(report.outputPlaylistCount, 2)
  assert.equal(report.duplicateGroupCount, 2)
  assert.equal(report.groups.filter(item => item.merge === 'identical').length, 1)
  assert.equal(report.groups.filter(item => item.merge === 'cover-metadata').length, 1)
  assert.equal(repaired.userList.find(item => item.id === 'cover')?.coverSongId, 'cover-1')
  assert.deepEqual(repaired.userList.map(item => item.list.map(song => song.id)), [['same-1'], ['cover-1']])
})

test('historical repair refuses duplicates whose song order or content differs', () => {
  const data = { defaultList: [], loveList: [], userList: [playlist('unsafe'), { ...playlist('unsafe'), list: [song('other')] }] }
  assert.throws(() => repairHistoricalDuplicatePlaylists(data), (error: any) => error?.code === 'unsafe_duplicate_playlist')
})

test('stable append preserves target order and deduplicates shared local paths', () => {
  const target = [song('remote-1'), song('local-a', { source: 'local', _localOwner: 'alice', _localFilename: 'a.flac' })]
  const source = [song('duplicate-id', { source: 'local', _localOwner: 'alice', _localFilename: 'a.flac' }), song('remote-2')]
  assert.deepEqual(appendSongsStable(target, source).map(item => item.id), ['remote-1', 'local-a', 'remote-2'])
})

test('historical numeric song IDs and durable local identities remain valid', () => {
  const data = {
    defaultList: [{ ...song('unused'), id: 29023858, songmid: 29023858 }],
    loveList: [{ ...song('unused-local'), id: undefined, _localOwner: 'alice', _localFilename: 'track.flac' }],
    userList: [],
  }
  assert.doesNotThrow(() => assertPlaylistData(data))
  assert.deepEqual(
    appendSongsStable([{ ...song('first'), id: 29023858 }], [{ ...song('duplicate'), id: 29023858 }]).length,
    1,
  )
})
