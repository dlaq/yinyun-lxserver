import crypto from 'node:crypto'

export class PlaylistInvariantError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message)
    this.name = 'PlaylistInvariantError'
  }
}

export interface PlaylistRepairGroup {
  id: string
  name: string
  occurrences: number
  trackCount: number
  merge: 'identical' | 'cover-metadata'
}

export interface PlaylistRepairReport {
  inputPlaylistCount: number
  outputPlaylistCount: number
  uniquePlaylistIds: number
  duplicateGroupCount: number
  removedDuplicateRecords: number
  groups: PlaylistRepairGroup[]
  beforeHash: string
  afterHash: string
  beforeTrackCounts: Record<string, number>
  afterTrackCounts: Record<string, number>
}

const isRecord = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

const normalizedScalarId = (value: unknown) => {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

const hasStableSongIdentity = (song: Record<string, any>) => Boolean(
  normalizedScalarId(song.id) ||
  (typeof song._localFilename === 'string' && song._localFilename.trim()),
)

const canonicalize = (value: any): any => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.keys(value).sort().reduce<Record<string, any>>((result, key) => {
    result[key] = canonicalize(value[key])
    return result
  }, {})
}

export const hashPlaylistData = (value: unknown) => crypto
  .createHash('sha256')
  .update(JSON.stringify(canonicalize(value)))
  .digest('hex')

const assertSongList = (value: unknown, context: string) => {
  if (!Array.isArray(value)) throw new PlaylistInvariantError('invalid_song_list', `${context} 必须是歌曲数组`)
  for (const [index, song] of value.entries()) {
    if (!isRecord(song)) throw new PlaylistInvariantError('invalid_song', `${context} 第 ${index + 1} 首歌曲结构无效`)
    // Older LX/NetEase snapshots legitimately store numeric song IDs. They
    // are stable JSON scalars and must not be confused with a missing ID.
    // A durable local-library filename is likewise the canonical identity for
    // shared local tracks that predate the synthetic top-level ID field.
    if (!hasStableSongIdentity(song)) {
      throw new PlaylistInvariantError('missing_song_id', `${context} 第 ${index + 1} 首歌曲缺少稳定 ID`)
    }
  }
}

export const assertPlaylistData: (
  value: unknown,
  options?: { allowHistoricalDuplicates?: boolean },
) => asserts value is LX.Sync.List.ListData = (
  value: unknown,
  options: { allowHistoricalDuplicates?: boolean } = {},
): asserts value is LX.Sync.List.ListData => {
  if (!isRecord(value)) throw new PlaylistInvariantError('invalid_playlist_data', '歌单数据必须是对象')
  assertSongList(value.defaultList, '默认列表')
  assertSongList(value.loveList, '收藏列表')
  if (!Array.isArray(value.userList)) throw new PlaylistInvariantError('invalid_user_list', '用户歌单必须是数组')

  const ids = new Set<string>()
  for (const [index, playlist] of value.userList.entries()) {
    if (!isRecord(playlist)) throw new PlaylistInvariantError('invalid_playlist', `第 ${index + 1} 个歌单结构无效`)
    const id = typeof playlist.id === 'string' ? playlist.id.trim() : ''
    if (!id) throw new PlaylistInvariantError('missing_playlist_id', `第 ${index + 1} 个歌单缺少 ID`)
    if (ids.has(id) && !options.allowHistoricalDuplicates) {
      throw new PlaylistInvariantError('duplicate_playlist_id', `歌单 ID 重复: ${id}`, { id, index })
    }
    ids.add(id)
    if (typeof playlist.name !== 'string') throw new PlaylistInvariantError('invalid_playlist_name', `歌单 ${id} 名称无效`)
    assertSongList(playlist.list, `歌单 ${playlist.name || id}`)
  }
}

const clone = <T>(value: T): T => structuredClone(value)

const withoutCoverMetadata = (playlist: Record<string, any>) => {
  const copy = clone(playlist)
  delete copy.coverSongId
  delete copy.coverUrl
  return copy
}

const mergeCoverMetadata = (target: Record<string, any>, duplicate: Record<string, any>) => {
  const targetCover = normalizedScalarId(target.coverSongId)
  const duplicateCover = normalizedScalarId(duplicate.coverSongId)
  if (targetCover && duplicateCover && targetCover !== duplicateCover) {
    throw new PlaylistInvariantError(
      'conflicting_cover_song',
      `重复歌单 ${target.id} 的 coverSongId 冲突，拒绝自动合并`,
      { targetCover, duplicateCover },
    )
  }
  if (!targetCover && duplicateCover) target.coverSongId = duplicate.coverSongId

  const targetCoverUrl = typeof target.coverUrl === 'string' ? target.coverUrl.trim() : ''
  const duplicateCoverUrl = typeof duplicate.coverUrl === 'string' ? duplicate.coverUrl.trim() : ''
  if (!targetCoverUrl && duplicateCoverUrl) target.coverUrl = duplicate.coverUrl
}

const trackCounts = (playlists: Array<Record<string, any>>) => Object.fromEntries(
  playlists.map(item => [String(item.id), Array.isArray(item.list) ? item.list.length : 0]),
)

export const repairHistoricalDuplicatePlaylists = (input: unknown): {
  repaired: LX.Sync.List.ListData
  report: PlaylistRepairReport
} => {
  assertPlaylistData(input, { allowHistoricalDuplicates: true })
  const source = clone(input) as LX.Sync.List.ListData
  const sourcePlaylists = source.userList as Array<Record<string, any>>
  const repairedPlaylists: Array<Record<string, any>> = []
  const byId = new Map<string, Record<string, any>>()
  const groups = new Map<string, PlaylistRepairGroup>()

  for (const playlist of sourcePlaylists) {
    const existing = byId.get(playlist.id)
    if (!existing) {
      const first = clone(playlist)
      byId.set(playlist.id, first)
      repairedPlaylists.push(first)
      continue
    }

    const identical = hashPlaylistData(existing) === hashPlaylistData(playlist)
    if (!identical && hashPlaylistData(withoutCoverMetadata(existing)) !== hashPlaylistData(withoutCoverMetadata(playlist))) {
      throw new PlaylistInvariantError(
        'unsafe_duplicate_playlist',
        `重复歌单 ${playlist.id} 的名称、时间、歌曲或顺序不一致，拒绝自动修复`,
        { id: playlist.id },
      )
    }

    mergeCoverMetadata(existing, playlist)
    const current = groups.get(playlist.id)
    groups.set(playlist.id, {
      id: playlist.id,
      name: String(existing.name || ''),
      occurrences: (current?.occurrences ?? 1) + 1,
      trackCount: Array.isArray(existing.list) ? existing.list.length : 0,
      merge: identical && current?.merge !== 'cover-metadata' ? 'identical' : 'cover-metadata',
    })
  }

  const repaired = {
    ...source,
    userList: repairedPlaylists,
  } as LX.Sync.List.ListData
  assertPlaylistData(repaired)

  const beforeHash = hashPlaylistData(source)
  const afterHash = hashPlaylistData(repaired)
  const report: PlaylistRepairReport = {
    inputPlaylistCount: sourcePlaylists.length,
    outputPlaylistCount: repairedPlaylists.length,
    uniquePlaylistIds: byId.size,
    duplicateGroupCount: groups.size,
    removedDuplicateRecords: sourcePlaylists.length - repairedPlaylists.length,
    groups: [...groups.values()],
    beforeHash,
    afterHash,
    beforeTrackCounts: trackCounts(sourcePlaylists),
    afterTrackCounts: trackCounts(repairedPlaylists),
  }
  return { repaired, report }
}

export const stableSongKey = (song: Record<string, any>): string => {
  const owner = typeof song._localOwner === 'string' ? song._localOwner.trim() : ''
  const filename = typeof song._localFilename === 'string' ? song._localFilename.trim() : ''
  if (filename) return `local:${owner}:${filename}`
  const source = typeof song.source === 'string' ? song.source.trim() : ''
  const id = normalizedScalarId(song.id)
  if (!id) throw new PlaylistInvariantError('missing_song_id', '歌曲缺少稳定 ID')
  return `${source || 'unknown'}:${id}`
}

export const appendSongsStable = <T extends Record<string, any>>(target: T[], source: T[]): T[] => {
  const keys = new Set(target.map(stableSongKey))
  const merged = target.map(clone)
  for (const song of source) {
    const key = stableSongKey(song)
    if (keys.has(key)) continue
    keys.add(key)
    merged.push(clone(song))
  }
  return merged
}
