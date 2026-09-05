import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  PlaylistImportStore,
  PlaylistSyncStore,
  SHARED_LIBRARY_MATCH_OPTIONS,
  anchorProviderSourceToMatchedFile,
  canonicalTrackId,
  localCandidatePathKey,
  matchTrack,
  matchTracksThroughLocalProvider,
  mergePlaylistIds,
  metadataAgreement,
  normalizeTitle,
  playlistSyncConflicts,
  preferExistingPlaylistCandidate,
  selectExplicitLocalCandidate,
  selectMatchedSharedLocalCandidate,
  toIntegrationTrack,
} from '../src/server/playlistIntegration'

test('playlist matching normalizes versions, artists, and mm:ss durations', () => {
  const title = normalizeTitle('  Blue Bird (Live版)  ')
  assert.equal(title.display, 'Blue Bird')
  assert.deepEqual(title.tags, ['live'])

  const source = toIntegrationTrack({ title: 'Blue Bird', artist: 'A / B', interval: '03:40' })
  const candidate = toIntegrationTrack({ id: 10, title: 'Blue Bird', artist: 'B & A', duration: 220 })
  assert.equal(source.duration, 220)
  const match = matchTrack(source, [candidate])
  assert.equal(match.status, 'matched')
  assert.equal(match.candidate?.id, 10)
})

test('playlist matching accepts a compact artist alias when title, album, and duration agree', () => {
  const source = toIntegrationTrack({ title: '勝利', artist: '六三四Musashi', album: 'NARUTO -ナルト- オリジナルサウンドトラック', duration: 107 })
  const candidate = toIntegrationTrack({ id: 1604, title: '勝利', artist: '六三四', album: 'NARUTO -ナルト- オリジナルサウンドトラック', duration: 107 })
  const match = matchTrack(source, [candidate])
  assert.equal(match.status, 'matched')
  assert.equal(match.candidate?.id, 1604)
  assert.equal(match.method, 'title_artist_exact')
})

test('playlist matching refuses low-confidence and tied candidates', () => {
  const source = toIntegrationTrack({ title: '同名歌曲', artist: '歌手甲' })
  const tied = [
    toIntegrationTrack({ id: 1, title: '同名歌曲', artist: '歌手乙' }),
    toIntegrationTrack({ id: 2, title: '同名歌曲', artist: '歌手丙' }),
  ]
  assert.equal(matchTrack(source, tied).status, 'missing')
  assert.equal(matchTrack(toIntegrationTrack({ title: '同名歌曲', artist: '同一歌手', duration: 100 }), [
    toIntegrationTrack({ id: 1, title: '同名歌曲', artist: '同一歌手', duration: 100 }),
    toIntegrationTrack({ id: 2, title: '同名歌曲', artist: '同一歌手', duration: 100 }),
  ]).status, 'ambiguous')
})

test('shared relative paths require metadata sanity and do not blindly raise a score', () => {
  const source = toIntegrationTrack({ title: '五月雨', artist: '高梨康治', album: 'NARUTO soundtrack II', duration: 207, relativePath: 'neteasy/高梨康治 - 五月雨.flac' })
  const sameFileDifferentTags = toIntegrationTrack({ title: '五月雨', artist: '刃-yaiba-', album: 'Yamagasumi (RUDE Remix)', duration: 207, relativePath: '/server/music/neteasy/高梨康治 - 五月雨.flac' })
  const agreement = metadataAgreement(source, sameFileDifferentTags)
  assert.equal(agreement.title, true)
  assert.equal(agreement.duration, true)
  assert.equal(agreement.strong, true)
  const matched = matchTrack(source, [sameFileDifferentTags])
  assert.equal(matched.status, 'matched')
  assert.equal(matched.score, 1)
  assert.equal(matched.method, 'relative_path_metadata')

  const unrelated = toIntegrationTrack({ title: '另一首歌', artist: '另一位歌手', duration: 180, relativePath: 'neteasy/高梨康治 - 五月雨.flac' })
  const rejected = matchTrack(source, [unrelated])
  assert.equal(rejected.status, 'missing')
  assert.equal(rejected.method, 'relative_path_conflict')
  assert.ok(rejected.score < 0.76)
})

test('provider comparison follows the confidently matched physical file metadata', () => {
  const source = toIntegrationTrack({
    title: 'The Ludlows (From "Legends Of The Fall" Soundtrack) (勒德洛一家)',
    artist: 'James Horner',
    album: 'Legends Of The Fall Original Motion Picture Soundtrack',
    duration: 340,
  })
  const local = toIntegrationTrack({
    title: 'The Ludlows (From "Legends Of The Fall" Soundtrack)',
    artist: 'James Horner',
    album: 'Legends Of The Fall Original Motion Picture Soundtrack',
    duration: 340,
    relativePath: 'The Ludlows - James Horner.flac',
    isLocal: true,
  })
  const primary = matchTrack(source, [local], SHARED_LIBRARY_MATCH_OPTIONS)
  assert.equal(primary.status, 'matched')

  const unanchored = matchTrack({ ...source, relativePath: local.relativePath }, [local], SHARED_LIBRARY_MATCH_OPTIONS)
  assert.equal(unanchored.status, 'missing')
  assert.equal(unanchored.method, 'relative_path_conflict')

  const anchored = anchorProviderSourceToMatchedFile(source, primary)
  const secondary = matchTrack(anchored, [local], SHARED_LIBRARY_MATCH_OPTIONS)
  assert.equal(secondary.status, 'matched')
  assert.equal(secondary.method, 'relative_path_metadata')

  const pipeline = matchTracksThroughLocalProvider([source], [local], [local], SHARED_LIBRARY_MATCH_OPTIONS)
  assert.equal(pipeline.localMatches[0].status, 'matched')
  assert.equal(pipeline.providerSources[0].title, local.title)
  assert.equal(pipeline.providerMatches[0].status, 'matched')
  assert.equal(pipeline.providerMatches[0].method, 'relative_path_metadata')
})

test('weak local candidates are not promoted into cover or accompaniment substitutions', () => {
  const original = toIntegrationTrack({ title: '从此以后', artist: '吴亦凡', duration: 256 })
  const cover = toIntegrationTrack({
    id: 4464,
    title: '从此以后（Cover：吴亦凡）',
    artist: '周珧',
    album: '可乐只要可口',
    duration: 257,
    relativePath: '从此以后（Cover：吴亦凡） - 周珧.mp3',
    isLocal: true,
  })
  const weak = matchTrack(original, [cover], SHARED_LIBRARY_MATCH_OPTIONS)
  assert.equal(weak.status, 'missing')
  assert.equal(selectMatchedSharedLocalCandidate(original, [weak]), null)

  const confirmed = { ...weak, status: 'matched' as const, candidate: cover, score: 1 }
  assert.equal(selectMatchedSharedLocalCandidate(original, [confirmed])?.track.relativePath, cover.relativePath)
})

test('an explicit local choice is bound to a current server-side candidate path', () => {
  const source = toIntegrationTrack({ title: 'Long translated online title', artist: 'Artist', duration: 437 })
  const shownLocal = toIntegrationTrack({
    title: 'Short local title',
    artist: 'Artist',
    duration: 437,
    relativePath: 'Album/Short local title.flac',
    isLocal: true,
  })
  const otherLocal = toIntegrationTrack({
    title: 'Another version',
    artist: 'Artist',
    duration: 420,
    relativePath: 'Album/Another version.flac',
    isLocal: true,
  })
  const match = matchTrack(source, [shownLocal, otherLocal], { threshold: 0.99 })
  assert.equal(match.status, 'missing')
  assert.equal(selectExplicitLocalCandidate(match)?.relativePath, shownLocal.relativePath)
  assert.equal(selectExplicitLocalCandidate(match, shownLocal.relativePath)?.relativePath, shownLocal.relativePath)
  assert.equal(selectExplicitLocalCandidate(match, 'Album/not-returned.flac'), undefined)
  assert.equal(localCandidatePathKey(shownLocal), 'album/short local title.flac')

  const onlineOnly = matchTrack(source, [toIntegrationTrack({ title: 'Short local title', artist: 'Artist', source: 'tx' })], { threshold: 0.99 })
  assert.equal(selectExplicitLocalCandidate(onlineOnly), undefined)
})

test('playlist matching can resolve exact duplicate library entities for playlist writes', () => {
  const source = toIntegrationTrack({ title: '我要你', artist: '任素汐', album: '我要你', duration: 154 })
  const candidates = [
    toIntegrationTrack({ id: 4013, title: '我要你', artist: '任素汐', album: '我要你', duration: 154, relativePath: 'flat.flac' }),
    toIntegrationTrack({ id: 3590, title: '我要你', artist: '任素汐', album: '我要你', duration: 154, relativePath: 'artist/album/song.flac', fingerprint: 'audio-fingerprint' }),
  ]
  assert.equal(matchTrack(source, candidates).status, 'ambiguous')
  const match = matchTrack(source, candidates, { resolveExactDuplicates: true })
  assert.equal(match.status, 'matched')
  assert.equal(match.candidate?.id, 4013)

  const liveCandidates = [
    toIntegrationTrack({ id: 3, title: '我要你 (Live)', artist: '任素汐', album: '演唱会', duration: 180 }),
    toIntegrationTrack({ id: 4, title: '我要你 (Live)', artist: '任素汐', album: '演唱会', duration: 180 }),
  ]
  assert.equal(matchTrack(source, liveCandidates, { resolveExactDuplicates: true }).status, 'ambiguous')
})

test('playlist matching reuses exactly one candidate already selected remotely', () => {
  const source = toIntegrationTrack({ title: 'Town of Windmill', artist: 'a_hisa', album: 'Single Collection', duration: 141 })
  const match = matchTrack(source, [
    toIntegrationTrack({ id: 11, title: 'Town of Windmill', artist: 'a_hisa', album: 'Single Collection', duration: 141 }),
    toIntegrationTrack({ id: 12, title: 'Town of Windmill', artist: 'a_hisa', album: 'Single Collection', duration: 141 }),
  ])
  assert.equal(match.status, 'ambiguous')
  const preserved = preferExistingPlaylistCandidate(match, new Set(['12']))
  assert.equal(preserved.status, 'matched')
  assert.equal(preserved.candidate?.id, 12)
  assert.equal(preserved.method, 'existing_playlist')
  assert.equal(preferExistingPlaylistCandidate(match, new Set(['11', '12'])).status, 'ambiguous')
})

test('playlist merge preserves additions and reports two-sided conflicts', () => {
  const merged = mergePlaylistIds(['a', 'b'], ['b', 'c'], ['a', 'd'])
  assert.deepEqual(merged.ids, ['c', 'd'])
  assert.deepEqual(merged.conflicts, ['removed_on_one_side'])
  assert.equal(canonicalTrackId(toIntegrationTrack({ title: 'Song', artist: 'Artist', album: 'Album' })), 'meta:song|artist|album')
})

test('authoritative playlist replacement clears historical conflict warnings', () => {
  assert.deepEqual(playlistSyncConflicts('push', 'replace', ['removed_on_one_side'], ['removed_on_one_side']), [])
  assert.deepEqual(playlistSyncConflicts('merge', 'merge', ['removed_on_one_side'], []), ['removed_on_one_side'])
})

test('playlist sync ledger survives a reload and writes atomically', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-playlist-sync-'))
  const filePath = path.join(root, 'sync.json')
  const store = new PlaylistSyncStore(filePath)
  const record = {
    syncId: 'admin:playlist-1',
    username: 'admin',
    name: 'Test',
    yinyunPlaylistId: 'playlist-1',
    songloftPlaylistId: 9,
    enabled: true,
    lastCommonIds: ['a'],
    lastYinyunHash: PlaylistSyncStore.hashIds(['a']),
    lastSongloftHash: PlaylistSyncStore.hashIds(['a']),
    updatedAt: new Date().toISOString(),
  }
  await store.upsert(record)
  const reloaded = new PlaylistSyncStore(filePath)
  assert.deepEqual(reloaded.load(), [record])
  assert.equal(reloaded.get(record.syncId)?.songloftPlaylistId, 9)
})

test('playlist import ledger keeps source tracks for later completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-playlist-import-'))
  const filePath = path.join(root, 'imports.json')
  const store = new PlaylistImportStore(filePath)
  const record = {
    importId: 'import_test',
    username: 'admin',
    source: 'qq',
    sourcePlaylistId: '123',
    name: '网络歌单',
    yinyunPlaylistId: 'playlist-1',
    tracks: [toIntegrationTrack({ id: 'song-1', source: 'qq', title: 'Song', artist: 'Artist' })],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await store.upsert(record)
  const reloaded = new PlaylistImportStore(filePath)
  const loaded = reloaded.load()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].importId, record.importId)
  assert.equal(loaded[0].tracks[0].source, 'qq')
  assert.equal(loaded[0].tracks[0].title, 'Song')
})

test('playlist import ledger lists detached history records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-playlist-history-'))
  const filePath = path.join(root, 'imports.json')
  const store = new PlaylistImportStore(filePath)
  const record = {
    importId: 'import_history',
    username: 'admin',
    source: 'wy',
    sourcePlaylistId: '148402843',
    name: '火影忍者超燃BGM',
    yinyunPlaylistId: 'playlist-history',
    tracks: [toIntegrationTrack({ id: 'song-1', source: 'wy', title: '五月雨', artist: '高梨康治' })],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await store.upsert(record)
  const listed = store.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].sourcePlaylistId, '148402843')
  listed[0].tracks[0].title = 'changed'
  assert.equal(store.get(record.importId)?.tracks[0].title, '五月雨')
})

test('playlist ledgers do not lose concurrent in-memory records on reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-playlist-concurrent-'))
  const filePath = path.join(root, 'imports.json')
  const store = new PlaylistImportStore(filePath)
  store.load()
  const makeRecord = (id: string) => ({
    importId: id,
    username: 'admin',
    source: 'wy',
    name: id,
    yinyunPlaylistId: `playlist-${id}`,
    tracks: [toIntegrationTrack({ id, source: 'wy', title: id, artist: 'Artist' })],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  const first = store.upsert(makeRecord('one'))
  store.load()
  const second = store.upsert(makeRecord('two'))
  await Promise.all([first, second])
  const reloaded = new PlaylistImportStore(filePath)
  assert.deepEqual(reloaded.load().map(record => record.importId).sort(), ['one', 'two'])
})
