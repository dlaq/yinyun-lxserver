import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type IntegrationTrack = {
  id?: string | number
  source?: string
  sourceId?: string | number
  title: string
  artist: string
  album?: string
  duration?: number
  relativePath?: string
  /** Present when the candidate came from Yinyun's local file index. */
  isLocal?: boolean
  folder?: 'cache' | 'music' | string
  storageLocation?: string
  libraryOwner?: string
  isrc?: string
  fingerprint?: string
  artworkUrl?: string
  raw?: unknown
}

export type TrackMatchStatus = 'matched' | 'ambiguous' | 'missing'

export type TrackMatch = {
  status: TrackMatchStatus
  source: IntegrationTrack
  candidate?: IntegrationTrack
  score: number
  method: string
  candidates: Array<{ track: IntegrationTrack; score: number; method: string }>
}

/**
 * [YINYUN-INTEGRATION] One scoring policy is shared by the Yinyun index,
 * Songloft native API, Songloft Subsonic fallback, and playlist imports.
 * Candidate evidence is ordered in scoreCandidate/candidateLibraryFor:
 * shared relative path with metadata sanity validation, ISRC, fingerprint,
 * normalized metadata + duration, then fuzzy similarity. A close second
 * candidate stays ambiguous on purpose. Embedded tags are read by the
 * Yinyun file index before tracks enter this matcher; this module does not
 * pretend that a filename alone is metadata.
 */
export const SHARED_LIBRARY_MATCH_OPTIONS = {
  threshold: 0.76,
  ambiguityMargin: 0.045,
  resolveExactDuplicates: true,
} as const

export type PlaylistMergeResult = {
  ids: string[]
  conflicts: Array<'removed_on_one_side' | 'reordered_on_both_sides'>
}

const VERSION_MARKERS: Array<[string, string]> = [
  ['live版', 'live'], ['现场版', 'live'], ['现场', 'live'], ['演唱会', 'live'], ['live', 'live'],
  ['remastered', 'remaster'], ['remaster', 'remaster'], ['重制', 'remaster'],
  ['remix', 'remix'], ['混音', 'remix'], ['重混', 'remix'],
  ['acoustic', 'acoustic'], ['unplugged', 'acoustic'], ['不插电', 'acoustic'],
  ['instrumental', 'instrumental'], ['伴奏', 'instrumental'], ['纯音乐', 'instrumental'],
  ['karaoke', 'karaoke'], ['ktv', 'karaoke'], ['demo', 'demo'], ['小样', 'demo'],
  ['cover', 'cover'], ['翻唱', 'cover'], ['dj', 'dj'], ['舞曲版', 'dj'],
  ['edit', 'edit'], ['单曲版', 'edit'], ['原版', 'original'], ['原唱', 'original'],
]

const text = (value: unknown) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()

const durationSeconds = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const raw = text(value)
  if (!raw) return undefined
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  const parts = raw.split(':').map(Number)
  if (parts.some(part => !Number.isFinite(part))) return undefined
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return undefined
}

const compact = (value: unknown) => text(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()
  .replace(/[^\p{Letter}\p{Number}\u3400-\u9fff]+/gu, '')

const normalizeRelativePath = (value: unknown) => {
  const raw = text(value).replace(/\\/g, '/')
  const marker = raw.toLocaleLowerCase().lastIndexOf('/music/')
  if (marker >= 0) return raw.slice(marker + '/music/'.length).toLocaleLowerCase()
  return raw.replace(/^\/?music\//i, '').replace(/^\/+/, '').toLocaleLowerCase()
}

const versionTags = (value: string): string[] => {
  const normalized = text(value).toLocaleLowerCase()
  return VERSION_MARKERS
    .filter(([marker]) => normalized.includes(marker))
    .map(([, tag]) => tag)
    .filter((tag, index, list) => list.indexOf(tag) === index)
}

export const normalizeTitle = (value: unknown) => {
  let title = text(value)
  const tags = new Set(versionTags(title))

  title = title.replace(/[([{（【「『][^\])}）】」』]*[\])}）】」』]/g, match => {
    const inside = match.slice(1, -1)
    const insideTags = versionTags(inside)
    insideTags.forEach(tag => tags.add(tag))
    return insideTags.length || /\b(?:feat|ft|with)\b|合唱|对唱/i.test(inside) ? ' ' : match
  })
  title = title.replace(/\s+(?:feat\.?|ft\.?|featuring|with|合唱|对唱)\s+.+$/i, '')
  for (let i = 0; i < 3; i++) {
    const next = title.replace(/(?:\s*[-–—|·:：]\s*|\s+)(live(?:版)?|现场版?|演唱会|remix|混音|重混|remaster(?:ed)?|重制|acoustic|unplugged|不插电|instrumental|伴奏|纯音乐|karaoke|ktv|demo|小样|cover|翻唱|dj(?:版)?|edit|单曲版|原版|原唱)\s*$/i, '')
    if (next === title) break
    title = next
  }
  const display = title.trim().replace(/^[-–—|·:：]+|[-–—|·:：]+$/g, '').replace(/\s+/g, ' ')
  return { display, key: compact(display), tags: [...tags].sort() }
}

export const normalizeArtists = (value: unknown) => {
  const raw = text(value)
  if (!raw || ['unknown', 'unknown artist', 'various artists', '未知', '群星'].includes(compact(raw))) return []
  return raw
    .replace(/[()[\]（）【】「」『』]/g, '/')
    .split(/\s*(?:\/|／|&|＆|、|,|，|;|；|•|·|×|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b|合唱|对唱|与|和)\s*/i)
    .map(compact)
    .filter(Boolean)
    .filter((artist, index, list) => list.indexOf(artist) === index)
}

const similarity = (left: string, right: string) => {
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.includes(right) || right.includes(left)) {
    const shorter = Math.min(left.length, right.length)
    if (shorter >= 3) return Math.max(shorter / Math.max(left.length, right.length), 0.75)
  }
  const matrix = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0))
  for (let i = 0; i <= left.length; i++) matrix[i][0] = i
  for (let j = 0; j <= right.length; j++) matrix[0][j] = j
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      matrix[i][j] = left[i - 1] === right[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + 1)
    }
  }
  return 1 - matrix[left.length][right.length] / Math.max(left.length, right.length)
}

const trackFeatures = (track: IntegrationTrack) => ({
  title: normalizeTitle(track.title),
  artists: normalizeArtists(track.artist),
  album: compact(track.album),
  isrc: compact(track.isrc),
  fingerprint: text(track.fingerprint),
  path: normalizeRelativePath(track.relativePath),
})

const sameValues = (left: string[], right: string[]) => left.length === right.length && left.every(value => right.includes(value))

export type MetadataAgreement = {
  title: boolean
  artist: boolean
  album: boolean
  duration: boolean
  externalId: boolean
  strong: boolean
}

/**
 * A relative path is a physical-file identity only when the metadata still
 * provides a minimum sanity check.  Songloft and Yinyun can disagree about
 * embedded artist/album tags for the same file, so requiring every field to
 * be equal would reintroduce the 13/12 split.  Conversely, accepting a path
 * with completely unrelated metadata would make a stale or colliding index
 * entry look like a match.  The rule therefore accepts an exact ISRC/fingerprint,
 * or an exact title plus one supporting field (artist, album, or duration).
 */
export const metadataAgreement = (source: IntegrationTrack, candidate: IntegrationTrack): MetadataAgreement => {
  const left = trackFeatures(source)
  const right = trackFeatures(candidate)
  const title = Boolean(left.title.key && left.title.key === right.title.key)
  const artistAlias = left.artists.some(value => right.artists.some(candidateArtist => {
    const shorter = Math.min(value.length, candidateArtist.length)
    return shorter >= 2 && (value.includes(candidateArtist) || candidateArtist.includes(value))
  }))
  const artist = Boolean(left.artists.length && right.artists.length && (
    sameValues(left.artists, right.artists) || left.artists.some(value => right.artists.includes(value)) || artistAlias
  ))
  const album = Boolean(left.album && right.album && left.album === right.album)
  const duration = Boolean(source.duration && candidate.duration && Math.abs(source.duration - candidate.duration) <= 3)
  const externalId = Boolean(
    (left.isrc && right.isrc && left.isrc === right.isrc) ||
    (left.fingerprint && right.fingerprint && left.fingerprint === right.fingerprint),
  )
  return {
    title,
    artist,
    album,
    duration,
    externalId,
    strong: externalId || (title && (artist || album || duration)),
  }
}

const hasStrongMetadataIdentity = (source: IntegrationTrack, candidate: IntegrationTrack) => {
  const left = trackFeatures(source)
  const right = trackFeatures(candidate)
  if (!left.title.key || left.title.key !== right.title.key) return false
  if (!left.artists.length || !sameValues(left.artists, right.artists)) return false
  if ((left.album || right.album) && left.album !== right.album) return false
  if (source.duration && candidate.duration && Math.abs(source.duration - candidate.duration) > 2) return false
  return true
}

const artistScore = (left: string[], right: string[]) => {
  if (!left.length || !right.length) return { score: 0.3, method: 'artist_missing' }
  if (left.join('|') === right.join('|')) return { score: 1, method: 'artist_exact' }
  const overlap = left.filter(value => right.includes(value)).length
  if (overlap > 0) return { score: Math.max(0.78, overlap / Math.max(left.length, right.length)), method: 'artist_overlap' }
  const prefixAlias = left.some(value => right.some(candidate => {
    const shorter = Math.min(value.length, candidate.length)
    return shorter >= 2 && (value.includes(candidate) || candidate.includes(value))
  }))
  if (prefixAlias) return { score: 0.92, method: 'artist_alias' }
  const pair = left.map(value => Math.max(...right.map(candidate => similarity(value, candidate))))
  const score = pair.reduce((sum, value) => sum + value, 0) / pair.length
  return { score, method: score >= 0.86 ? 'artist_fuzzy' : 'artist_mismatch' }
}

const scoreCandidate = (source: IntegrationTrack, candidate: IntegrationTrack) => {
  const left = trackFeatures(source)
  const right = trackFeatures(candidate)
  if (left.path && right.path && left.path === right.path) {
    // Same path is the strongest physical identity, but still validate it
    // against metadata.  A conflict remains visible as a low-confidence
    // candidate instead of being silently promoted to a match.
    return metadataAgreement(source, candidate).strong
      ? { score: 1, method: 'relative_path_metadata' }
      : { score: 0.72, method: 'relative_path_conflict' }
  }
  if (left.isrc && right.isrc && left.isrc === right.isrc) return { score: 1, method: 'isrc' }
  if (left.fingerprint && right.fingerprint && left.fingerprint === right.fingerprint) return { score: 1, method: 'fingerprint' }

  const title = similarity(left.title.key, right.title.key)
  const artists = artistScore(left.artists, right.artists)
  const album = left.album && right.album ? similarity(left.album, right.album) : 0
  const duration = source.duration && candidate.duration
    ? Math.max(0, 1 - Math.abs(source.duration - candidate.duration) / Math.max(source.duration, candidate.duration, 1))
    : 0.5
  const sourceTags = new Set(left.title.tags)
  const candidateTags = new Set(right.title.tags)
  const version = sourceTags.size === 0 || candidateTags.size === 0
    ? 0.86
    : [...sourceTags].some(tag => candidateTags.has(tag)) ? 0.95 : 0.65
  const score = (title * 0.48 + artists.score * 0.32 + album * 0.08 + duration * 0.12) * version
  const method = title >= 0.98 && artists.score >= 0.92 ? 'title_artist_exact'
    : title >= 0.9 && artists.score >= 0.78 ? 'title_artist_fuzzy'
      : 'fuzzy'
  return { score, method }
}

export const matchTrack = (source: IntegrationTrack, library: IntegrationTrack[], options: { threshold?: number; ambiguityMargin?: number; resolveExactDuplicates?: boolean } = {}): TrackMatch => {
  const threshold = options.threshold ?? 0.76
  const ambiguityMargin = options.ambiguityMargin ?? 0.045
  const candidates = library
    .map(track => ({ track, ...scoreCandidate(source, track) }))
    .sort((left, right) => right.score - left.score)
  const best = candidates[0]
  if (!best || best.score < threshold) return { status: 'missing', source, score: best?.score || 0, method: best?.method || 'none', candidates: candidates.slice(0, 5) }
  const second = candidates[1]
  const resolvableExactDuplicate = options.resolveExactDuplicates === true && hasStrongMetadataIdentity(source, best.track)
  if (second && best.score - second.score < ambiguityMargin && best.score < 0.94 && !resolvableExactDuplicate) {
    return { status: 'ambiguous', source, candidate: best.track, score: best.score, method: best.method, candidates: candidates.slice(0, 5) }
  }
  return { status: 'matched', source, candidate: best.track, score: best.score, method: best.method, candidates: candidates.slice(0, 5) }
}

type TrackIndex = {
  byPath: Map<string, IntegrationTrack[]>
  byIsrc: Map<string, IntegrationTrack[]>
  byFingerprint: Map<string, IntegrationTrack[]>
  byTitle: Map<string, IntegrationTrack[]>
  byArtist: Map<string, IntegrationTrack[]>
  byPrefix: Map<string, IntegrationTrack[]>
}

const addToIndex = (index: Map<string, IntegrationTrack[]>, key: string, track: IntegrationTrack) => {
  if (!key) return
  const list = index.get(key)
  if (list) list.push(track)
  else index.set(key, [track])
}

const buildTrackIndex = (library: IntegrationTrack[]): TrackIndex => {
  const index: TrackIndex = {
    byPath: new Map(),
    byIsrc: new Map(),
    byFingerprint: new Map(),
    byTitle: new Map(),
    byArtist: new Map(),
    byPrefix: new Map(),
  }
  for (const track of library) {
    const features = trackFeatures(track)
    addToIndex(index.byPath, features.path, track)
    addToIndex(index.byIsrc, features.isrc, track)
    addToIndex(index.byFingerprint, features.fingerprint, track)
    addToIndex(index.byTitle, features.title.key, track)
    for (const artist of features.artists) addToIndex(index.byArtist, artist, track)
    const prefix = features.title.key.slice(0, Math.min(4, features.title.key.length))
    if (prefix.length >= 2) addToIndex(index.byPrefix, prefix, track)
  }
  return index
}

const candidateLibraryFor = (source: IntegrationTrack, library: IntegrationTrack[], index: TrackIndex) => {
  const features = trackFeatures(source)
  const candidates = new Set<IntegrationTrack>()
  const add = (tracks?: IntegrationTrack[]) => tracks?.forEach(track => candidates.add(track))
  add(index.byPath.get(features.path))
  add(index.byIsrc.get(features.isrc))
  add(index.byFingerprint.get(features.fingerprint))
  add(index.byTitle.get(features.title.key))
  for (const artist of features.artists) add(index.byArtist.get(artist))
  const prefix = features.title.key.slice(0, Math.min(4, features.title.key.length))
  if (!candidates.size && prefix.length >= 2) {
    const prefixed = index.byPrefix.get(prefix)
    // A short/common prefix (for example a Chinese title prefix) can cover
    // the whole library. It is useful only when it remains selective.
    if (prefixed && prefixed.length <= 500) add(prefixed)
  }

  // Small libraries retain the old full fuzzy fallback. Large libraries use
  // indexed candidates only so a 100+ track playlist does not compare every
  // source song against tens of thousands of files.
  if (!candidates.size && library.length <= 2000) return library
  return [...candidates]
}

export const matchTracks = (sources: IntegrationTrack[], library: IntegrationTrack[], options: { threshold?: number; ambiguityMargin?: number; resolveExactDuplicates?: boolean } = {}) => {
  const index = buildTrackIndex(library)
  return sources.map(source => matchTrack(source, candidateLibraryFor(source, library, index), options))
}

/** Preserve an already chosen remote entity when a fresh metadata match is
 * ambiguous. This never invents a new choice: exactly one of the candidates
 * must already be present in the target playlist. */
export const preferExistingPlaylistCandidate = (match: TrackMatch, existingIds: Set<string>): TrackMatch => {
  if (match.status !== 'ambiguous') return match
  const existing = match.candidates.filter(item => existingIds.has(String(item.track.id ?? item.track.sourceId ?? '')))
  if (existing.length !== 1) return match
  const chosen = existing[0]
  return { ...match, status: 'matched', candidate: chosen.track, score: chosen.score, method: 'existing_playlist' }
}

export const canonicalTrackId = (track: IntegrationTrack) => {
  const features = trackFeatures(track)
  if (features.path) return `path:${features.path}`
  if (features.isrc) return `isrc:${features.isrc}`
  if (features.fingerprint) return `fingerprint:${features.fingerprint}`
  const title = features.title.key || compact(track.title)
  const artist = features.artists.join('|') || compact(track.artist)
  return `meta:${title}|${artist}|${features.album}`
}

export const mergePlaylistIds = (base: string[], local: string[], remote: string[]): PlaylistMergeResult => {
  const baseSet = new Set(base)
  const localSet = new Set(local)
  const remoteSet = new Set(remote)
  const conflicts: PlaylistMergeResult['conflicts'] = []
  const localRemoved = base.some(id => !localSet.has(id))
  const remoteRemoved = base.some(id => !remoteSet.has(id))
  if (localRemoved && remoteRemoved) conflicts.push('removed_on_one_side')

  const localOrderChanged = base.filter(id => localSet.has(id)).join('|') !== local.filter(id => baseSet.has(id)).join('|')
  const remoteOrderChanged = base.filter(id => remoteSet.has(id)).join('|') !== remote.filter(id => baseSet.has(id)).join('|')
  if (localOrderChanged && remoteOrderChanged && local.filter(id => baseSet.has(id)).join('|') !== remote.filter(id => baseSet.has(id)).join('|')) {
    conflicts.push('reordered_on_both_sides')
  }

  const result: string[] = []
  const append = (id: string) => { if (!result.includes(id)) result.push(id) }
  for (const id of local) if (!baseSet.has(id) || remoteSet.has(id)) append(id)
  for (const id of remote) if (!baseSet.has(id) || localSet.has(id)) append(id)
  for (const id of base) if (localSet.has(id) && remoteSet.has(id)) append(id)
  return { ids: result, conflicts }
}

export const playlistSyncConflicts = (
  direction: 'push' | 'pull' | 'merge',
  mode: 'merge' | 'replace',
  initial: string[],
  final: string[],
) => direction === 'push' && mode === 'replace'
  ? []
  : [...new Set([...initial, ...final])]

/**
 * Empty input is not a meaningful authoritative state for a destructive
 * cross-system replace. It is commonly produced by a transient empty snapshot
 * or a UI race, and historically caused a populated Songloft playlist to be
 * reduced to zero. An explicit opt-in is kept for API clients that genuinely
 * intend to clear a remote playlist.
 */
export const playlistReplacementSafetyIssue = (
  sourceTrackCount: number,
  currentRemoteIds: Array<number | string>,
  desiredRemoteIds: Array<number | string>,
  allowEmptyReplace = false,
) => {
  if (allowEmptyReplace || currentRemoteIds.length === 0) return null
  if (sourceTrackCount === 0) return 'empty_source_playlist'
  if (desiredRemoteIds.length === 0) return 'empty_resolved_playlist'
  return null
}

export type PlaylistSyncRecord = {
  syncId: string
  username: string
  name: string
  yinyunPlaylistId: string
  songloftPlaylistId: number
  enabled: boolean
  lastCommonIds: string[]
  lastYinyunHash: string
  lastSongloftHash: string
  updatedAt: string
}

/**
 * A persisted snapshot of an imported third-party playlist.  The snapshot is
 * deliberately kept on the yinyun side: it is only a source-of-truth ledger
 * for matching and download decisions, never a Songloft/MusicHub download
 * queue.  Keeping the original normalized song object means a later manual
 * or one-click completion can enqueue the same 洛雪/音云 source item without
 * asking the caller to submit the whole online playlist again.
 */
export type PlaylistImportRecord = {
  importId: string
  username: string
  source: string
  sourcePlaylistId?: string
  sourcePlaylistName?: string
  name: string
  yinyunPlaylistId: string
  tracks: IntegrationTrack[]
  /** User-confirmed provider for an ambiguous row, keyed by source index. */
  resolutions?: Record<string, 'yinyun' | 'songloft' | 'local'>
  /** Snapshot of the candidate selected by the user, keyed by source index. */
  resolvedCandidates?: Record<string, IntegrationTrack>
  createdAt: string
  updatedAt: string
}

type PlaylistImportStorePayload = { version: 1; records: PlaylistImportRecord[] }

/** Small atomic JSON ledger used by the playlist import/complete endpoints. */
export class PlaylistImportStore {
  private payload: PlaylistImportStorePayload = { version: 1, records: [] }
  private writeChain: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(private readonly filePath: string) {}

  private detachedRecord(record: PlaylistImportRecord) {
    return {
      ...record,
      tracks: record.tracks.map(track => ({ ...track })),
      resolutions: record.resolutions ? { ...record.resolutions } : undefined,
      resolvedCandidates: record.resolvedCandidates
        ? Object.fromEntries(Object.entries(record.resolvedCandidates).map(([index, track]) => [index, { ...track }]))
        : undefined,
    }
  }

  load() {
    if (this.loaded) return this.payload.records.map(record => this.detachedRecord(record))
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<PlaylistImportStorePayload>
      if (raw.version === 1 && Array.isArray(raw.records)) {
        this.payload = { version: 1, records: raw.records as PlaylistImportRecord[] }
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.warn('[PlaylistImport] failed to load ledger:', error?.message || error)
    }
    this.loaded = true
    return this.payload.records.map(record => this.detachedRecord(record))
  }

  get(importId: string) { return this.payload.records.find(record => record.importId === importId) }

  /** Return a detached copy so callers can render history without mutating the ledger. */
  list() {
    if (!this.loaded) this.load()
    return this.payload.records.map(record => this.detachedRecord(record))
  }

  upsert(record: PlaylistImportRecord) {
    if (!this.loaded) this.load()
    const index = this.payload.records.findIndex(item => item.importId === record.importId)
    if (index < 0) this.payload.records.push(record)
    else this.payload.records[index] = record
    const write = async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      await fs.promises.writeFile(temporary, `${JSON.stringify(this.payload, null, 2)}\n`, 'utf8')
      await fs.promises.rename(temporary, this.filePath)
    }
    this.writeChain = this.writeChain.then(write, write)
    return this.writeChain
  }
}

type StorePayload = { version: 1; records: PlaylistSyncRecord[] }

const hashIds = (ids: string[]) => crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex')

export class PlaylistSyncStore {
  private payload: StorePayload = { version: 1, records: [] }
  private writeChain: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(private readonly filePath: string) {}

  load() {
    if (this.loaded) return this.payload.records.map(record => ({ ...record, lastCommonIds: [...record.lastCommonIds] }))
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<StorePayload>
      if (raw.version === 1 && Array.isArray(raw.records)) this.payload = { version: 1, records: raw.records as PlaylistSyncRecord[] }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.warn('[PlaylistSync] failed to load ledger:', error?.message || error)
    }
    this.loaded = true
    return this.payload.records.map(record => ({ ...record, lastCommonIds: [...record.lastCommonIds] }))
  }

  get(syncId: string) { return this.payload.records.find(record => record.syncId === syncId) }

  upsert(record: PlaylistSyncRecord) {
    if (!this.loaded) this.load()
    const index = this.payload.records.findIndex(item => item.syncId === record.syncId)
    if (index < 0) this.payload.records.push(record)
    else this.payload.records[index] = record
    const write = async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      await fs.promises.writeFile(temporary, `${JSON.stringify(this.payload, null, 2)}\n`, 'utf8')
      await fs.promises.rename(temporary, this.filePath)
    }
    this.writeChain = this.writeChain.then(write, write)
    return this.writeChain
  }

  remove(syncId: string) {
    if (!this.loaded) this.load()
    const index = this.payload.records.findIndex(record => record.syncId === syncId)
    if (index < 0) return Promise.resolve()
    this.payload.records.splice(index, 1)
    const write = async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      await fs.promises.writeFile(temporary, `${JSON.stringify(this.payload, null, 2)}\n`, 'utf8')
      await fs.promises.rename(temporary, this.filePath)
    }
    this.writeChain = this.writeChain.then(write, write)
    return this.writeChain
  }

  static hashIds(ids: string[]) { return hashIds(ids) }
}

export const toIntegrationTrack = (value: any): IntegrationTrack => ({
  id: value?.id,
  source: value?.source,
  sourceId: value?.sourceId || value?.songmid || value?.songId || value?.id,
  title: String(value?.title || value?.name || ''),
  artist: String(value?.artist || value?.singer || ''),
  album: String(value?.album || value?.albumName || ''),
  duration: durationSeconds(value?.duration ?? value?.interval),
  relativePath: value?.relativePath || value?._localFilename || value?.file_path,
  isLocal: Boolean(value?.isLocal || value?.folder || value?.storageLocation || value?.filename),
  folder: value?.folder,
  storageLocation: value?.storageLocation || value?._localStorageLocation,
  libraryOwner: value?.libraryOwner || value?._localOwner,
  isrc: value?.isrc,
  fingerprint: value?.fingerprint,
  artworkUrl: value?.artworkUrl || value?.coverUrl || value?.cover_url || value?.picUrl || value?.pic_url || value?.img || value?.raw?.artworkUrl || value?.raw?.coverUrl || value?.raw?.cover_url || undefined,
  raw: value,
})
