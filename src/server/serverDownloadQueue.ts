import fs from 'node:fs'
import path from 'node:path'
import * as fileCache from './fileCache'
import { tryNormalizeUsername } from '@/utils/username'
import { normalizeLyricOutputFormat } from '@/utils/lrcTool'
import type { LyricOutputFormat } from '@/utils/lrcTool'

export type ServerDownloadStatus = 'waiting' | 'downloading' | 'tagging' | 'paused' | 'finished' | 'exists' | 'error'

export interface ServerDownloadTask {
  id: string
  username: string
  songKey: string
  activeSongKey?: string
  songInfo: any
  quality: string
  requestedQuality: string
  status: ServerDownloadStatus
  progress: number
  total: number
  received: number
  speed: number
  errorMsg: string
  enableOnlyDownloadMode: boolean
  cacheLyric: boolean
  embedLyric: boolean
  sidecarLyricFormat: LyricOutputFormat
  embedLyricFormat: LyricOutputFormat
  playlistName?: string
  playlistId?: string
  playlistImportId?: string
  /** Explicit local-file replacement metadata for playlist completion. */
  replacement?: any
  queuedAt: number
  startedAt?: number
  completedAt?: number
  failedAt?: number
  retryCount: number
  createdAt: number
  updatedAt: number
}

interface QueueInput {
  id?: string
  songInfo: any
  quality?: string
  enableOnlyDownloadMode?: boolean
  cacheLyric?: boolean
  embedLyric?: boolean
  sidecarLyricFormat?: LyricOutputFormat
  embedLyricFormat?: LyricOutputFormat
  playlistName?: string
  playlistId?: string
  playlistImportId?: string
  replacement?: any
  queuedAt?: number | string
}

interface ResolveResult {
  url: string
  quality?: string
  songInfo?: any
  requestedSource?: string
  downloadSource?: string
  sourceName?: string
}

type DownloadResolver = (task: ServerDownloadTask) => Promise<ResolveResult>
type DownloadCompletionHandler = (task: ServerDownloadTask) => Promise<void> | void

const DEFAULT_CONCURRENT = 3
const MAX_CONCURRENT_PER_USER = 5
const tasks = new Map<string, ServerDownloadTask>()
const controllers = new Map<string, AbortController>()
const concurrencyByUser = new Map<string, number>()
let resolver: DownloadResolver | null = null
let completionHandler: DownloadCompletionHandler | null = null
let initialized = false
let processing = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

const taskMapKey = (username: string, id: string) => `${username}:${id}`
const getQueueFile = () => path.join(global.lx.dataPath, 'server-download-queue.json')
const validStatuses = new Set<ServerDownloadStatus>(['waiting', 'downloading', 'tagging', 'paused', 'finished', 'exists', 'error'])

const getConfiguredQueueUser = (username: unknown): string | null => {
  const normalized = tryNormalizeUsername(username)
  return normalized && global.lx.config.users.some(user => user.name === normalized) ? normalized : null
}

const assertConfiguredQueueUser = (username: unknown): string => {
  const normalized = getConfiguredQueueUser(username)
  if (!normalized) throw new Error('Download task user no longer exists')
  return normalized
}

const normalizeConcurrency = (value: unknown) => {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENT
  return Math.min(MAX_CONCURRENT_PER_USER, Math.max(1, parsed))
}

const normalizeTimestamp = (value: unknown, fallback: number) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const getConcurrency = (username: string) => {
  const normalized = tryNormalizeUsername(username)
  return normalized ? concurrencyByUser.get(normalized) || DEFAULT_CONCURRENT : DEFAULT_CONCURRENT
}

const sanitizeId = (value: unknown) => {
  const id = String(value || '')
  return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : `server_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

const saveNow = () => {
  if (!initialized) return
  const file = getQueueFile()
  const tempFile = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tempFile, JSON.stringify({
      version: 2,
      concurrencyByUser: Object.fromEntries(concurrencyByUser),
      tasks: Array.from(tasks.values()),
    }, null, 2), 'utf8')
    fs.renameSync(tempFile, file)
  } catch (err) {
    console.warn('[ServerDownloadQueue] Failed to save queue:', err)
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile) } catch (e) { }
  }
}

const scheduleSave = () => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 150)
}

const loadTasks = () => {
  const file = getQueueFile()
  if (!fs.existsSync(file)) return
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const savedTasks = Array.isArray(data) ? data : data?.tasks
    if (!Array.isArray(savedTasks)) return
    if (!Array.isArray(data) && data?.concurrencyByUser && typeof data.concurrencyByUser === 'object') {
      for (const [username, value] of Object.entries(data.concurrencyByUser)) {
        const normalizedUsername = getConfiguredQueueUser(username)
        if (!normalizedUsername) continue
        concurrencyByUser.set(normalizedUsername, normalizeConcurrency(value))
      }
    }
    for (const raw of savedTasks) {
      const normalizedUsername = getConfiguredQueueUser(raw?.username)
      if (!raw || !normalizedUsername || !raw.songInfo) continue
      const id = sanitizeId(raw.id)
      const savedStatus = validStatuses.has(raw.status) ? raw.status as ServerDownloadStatus : 'waiting'
      const status: ServerDownloadStatus = savedStatus === 'downloading' || savedStatus === 'tagging' ? 'waiting' : savedStatus
      const quality = String(raw.quality || raw.requestedQuality || '320k')
      const requestedQuality = String(raw.requestedQuality || quality)
      const now = Date.now()
      const task: ServerDownloadTask = {
        id,
        username: normalizedUsername,
        songKey: String(raw.songKey || `${fileCache.normalizeSongId(raw.songInfo)}_${requestedQuality}`),
        activeSongKey: status === 'waiting' ? undefined : raw.activeSongKey ? String(raw.activeSongKey) : undefined,
        songInfo: raw.songInfo,
        quality: status === 'waiting' ? requestedQuality : quality,
        requestedQuality,
        status,
        progress: status === 'waiting' ? 0 : Number(raw.progress || 0),
        total: status === 'waiting' ? 0 : Number(raw.total || 0),
        received: status === 'waiting' ? 0 : Number(raw.received || 0),
        speed: 0,
        errorMsg: status === 'waiting' ? '' : String(raw.errorMsg || ''),
        enableOnlyDownloadMode: !!raw.enableOnlyDownloadMode,
        cacheLyric: raw.cacheLyric !== false,
        embedLyric: raw.embedLyric !== false,
        sidecarLyricFormat: normalizeLyricOutputFormat(raw.sidecarLyricFormat),
        embedLyricFormat: normalizeLyricOutputFormat(raw.embedLyricFormat),
        playlistName: raw.playlistName ? String(raw.playlistName) : undefined,
        playlistId: raw.playlistId ? String(raw.playlistId) : undefined,
        playlistImportId: raw.playlistImportId ? String(raw.playlistImportId) : undefined,
        replacement: raw.replacement && typeof raw.replacement === 'object' ? raw.replacement : undefined,
        queuedAt: normalizeTimestamp(raw.queuedAt, normalizeTimestamp(raw.createdAt, now)),
        startedAt: raw.startedAt ? normalizeTimestamp(raw.startedAt, now) : undefined,
        completedAt: raw.completedAt ? normalizeTimestamp(raw.completedAt, now) : (['finished', 'exists'].includes(status) ? normalizeTimestamp(raw.updatedAt, now) : undefined),
        failedAt: raw.failedAt ? normalizeTimestamp(raw.failedAt, now) : (status === 'error' ? normalizeTimestamp(raw.updatedAt, now) : undefined),
        retryCount: Number(raw.retryCount || 0),
        createdAt: Number(raw.createdAt || now),
        updatedAt: now,
      }
      tasks.set(taskMapKey(task.username, task.id), task)
    }
    console.log(`[ServerDownloadQueue] Restored ${tasks.size} persisted tasks`)
  } catch (err) {
    console.warn('[ServerDownloadQueue] Failed to restore queue:', err)
  }
}

const getPublicTask = (task: ServerDownloadTask) => {
  const live = task.status === 'downloading' && task.activeSongKey
    ? fileCache.cacheProgress.get(task.activeSongKey)
    : undefined
  const liveStatus = live?.status as ServerDownloadStatus | undefined
  return {
    id: task.id,
    songKey: task.activeSongKey || task.songKey,
    songInfo: task.songInfo,
    quality: task.quality,
    requestedQuality: task.requestedQuality,
    status: liveStatus || task.status,
    progress: Number(live?.progress ?? task.progress ?? 0),
    total: Number(live?.total ?? task.total ?? 0),
    received: Number(live?.received ?? task.received ?? 0),
    speed: Number(live?.speed ?? task.speed ?? 0),
    errorMsg: String(live?.errorMsg || task.errorMsg || ''),
    sidecarLyricFormat: task.sidecarLyricFormat,
    embedLyricFormat: task.embedLyricFormat,
    playlistName: task.playlistName || task.songInfo?.playlistName || task.songInfo?.playlist,
    playlistId: task.playlistId,
    playlistImportId: task.playlistImportId,
    replacement: task.replacement,
    queuedAt: task.queuedAt || task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    failedAt: task.failedAt,
    retryCount: task.retryCount || 0,
    createdAt: task.createdAt,
    updatedAt: Number(live?.updatedAt || task.updatedAt),
  }
}

const runTask = async (task: ServerDownloadTask) => {
  if (!resolver || task.status !== 'waiting') return
  const key = taskMapKey(task.username, task.id)
  const controller = new AbortController()
  controllers.set(key, controller)
  task.status = 'downloading'
  task.progress = 0
  task.total = 0
  task.received = 0
  task.speed = 0
  task.errorMsg = ''
  task.startedAt = Date.now()
  task.completedAt = undefined
  task.failedAt = undefined
  task.updatedAt = Date.now()
  scheduleSave()

  try {
    const resolved = await resolver(task)
    if (controller.signal.aborted) return
    if (!resolved?.url) throw new Error('无法解析下载地址')
    task.songInfo = resolved.songInfo || task.songInfo
    task.quality = resolved.quality || task.requestedQuality
    task.activeSongKey = fileCache.normalizeSongId(task.songInfo) + '_' + task.quality
    task.updatedAt = Date.now()
    scheduleSave()

    await fileCache.downloadAndCache(task.songInfo, resolved.url, task.quality, task.username, controller.signal,
      task.enableOnlyDownloadMode, task.cacheLyric, task.embedLyric, {
        requestedSource: resolved.requestedSource,
        downloadSource: resolved.downloadSource,
        sourceName: resolved.sourceName,
      }, {
        sidecarFormat: task.sidecarLyricFormat,
        embedFormat: task.embedLyricFormat,
      })

    if (controller.signal.aborted) return
    const progress = fileCache.cacheProgress.get(task.activeSongKey)
    task.status = progress?.status === 'exists' ? 'exists' : 'finished'
    task.progress = 100
    task.total = Number(progress?.total || progress?.received || task.total || 0)
    task.received = Number(progress?.received || task.total || 0)
    task.speed = 0
    task.errorMsg = ''
    task.completedAt = Date.now()
    task.failedAt = undefined
  } catch (err: any) {
    if (controller.signal.aborted || err?.message === 'Aborted') {
      task.status = 'paused'
      task.errorMsg = '已暂停'
    } else {
      task.status = 'error'
      task.errorMsg = err?.message || '下载失败'
      task.failedAt = Date.now()
    }
    task.speed = 0
  } finally {
    if (completionHandler && ['finished', 'exists'].includes(task.status)) {
      try { await completionHandler(task) } catch (error: any) {
        console.warn('[ServerDownloadQueue] completion hook failed:', error?.message || error)
      }
    }
    controllers.delete(key)
    task.updatedAt = Date.now()
    scheduleSave()
    void processQueue()
  }
}

const processQueue = async () => {
  if (processing || !resolver) return
  processing = true
  try {
    while (true) {
      const activeByUser = new Map<string, number>()
      for (const key of controllers.keys()) {
        const username = tasks.get(key)?.username
        if (!username) continue
        activeByUser.set(username, (activeByUser.get(username) || 0) + 1)
      }
      const next = Array.from(tasks.values()).find(task => (
        task.status === 'waiting' && (activeByUser.get(task.username) || 0) < getConcurrency(task.username)
      ))
      if (!next) break
      void runTask(next)
    }
  } finally {
    processing = false
  }
}

export const setConcurrency = (username: string, value: unknown) => {
  username = assertConfiguredQueueUser(username)
  const concurrency = normalizeConcurrency(value)
  concurrencyByUser.set(username, concurrency)
  saveNow()
  void processQueue()
  return concurrency
}

export const initialize = (downloadResolver: DownloadResolver) => {
  resolver = downloadResolver
  if (!initialized) {
    initialized = true
    loadTasks()
    saveNow()
  }
  void processQueue()
}

/**
 * Register a side-effect hook for successfully materialized music.  The
 * resolver remains the only download path; this hook is for post-download
 * integrations such as debounced Navidrome/Songloft rescans.
 */
export const setCompletionHandler = (handler: DownloadCompletionHandler | null) => {
  completionHandler = handler
}

export const enqueue = (username: string, inputs: QueueInput[]) => {
  username = assertConfiguredQueueUser(username)
  const added: ServerDownloadTask[] = []
  for (const input of inputs) {
    if (!input?.songInfo) continue
    const id = sanitizeId(input.id)
    const key = taskMapKey(username, id)
    const quality = input.quality || '320k'
    const existing = tasks.get(key)
    if (existing) {
      if (['waiting', 'downloading', 'tagging'].includes(existing.status)) continue

      const now = Date.now()
      existing.songKey = fileCache.normalizeSongId(input.songInfo) + '_' + quality
      existing.activeSongKey = undefined
      existing.songInfo = input.songInfo
      existing.quality = quality
      existing.requestedQuality = quality
      existing.status = 'waiting'
      existing.progress = 0
      existing.total = 0
      existing.received = 0
      existing.speed = 0
      existing.errorMsg = ''
      existing.enableOnlyDownloadMode = !!input.enableOnlyDownloadMode
      existing.cacheLyric = input.cacheLyric !== false
      existing.embedLyric = input.embedLyric !== false
      existing.sidecarLyricFormat = normalizeLyricOutputFormat(input.sidecarLyricFormat)
      existing.embedLyricFormat = normalizeLyricOutputFormat(input.embedLyricFormat)
      existing.playlistName = input.playlistName ? String(input.playlistName) : undefined
      existing.playlistId = input.playlistId ? String(input.playlistId) : undefined
      existing.playlistImportId = input.playlistImportId ? String(input.playlistImportId) : undefined
      existing.replacement = input.replacement && typeof input.replacement === 'object' ? input.replacement : undefined
      existing.queuedAt = normalizeTimestamp(input.queuedAt, now)
      existing.startedAt = undefined
      existing.completedAt = undefined
      existing.failedAt = undefined
      existing.retryCount = existing.retryCount || 0
      existing.createdAt = now
      existing.updatedAt = now
      added.push(existing)
      continue
    }
    const now = Date.now()
    const task: ServerDownloadTask = {
      id, username,
      songKey: fileCache.normalizeSongId(input.songInfo) + '_' + quality,
      songInfo: input.songInfo,
      quality,
      requestedQuality: quality,
      status: 'waiting', progress: 0, total: 0, received: 0, speed: 0, errorMsg: '',
      enableOnlyDownloadMode: !!input.enableOnlyDownloadMode,
      cacheLyric: input.cacheLyric !== false,
      embedLyric: input.embedLyric !== false,
      sidecarLyricFormat: normalizeLyricOutputFormat(input.sidecarLyricFormat),
      embedLyricFormat: normalizeLyricOutputFormat(input.embedLyricFormat),
      playlistName: input.playlistName ? String(input.playlistName) : undefined,
      playlistId: input.playlistId ? String(input.playlistId) : undefined,
      playlistImportId: input.playlistImportId ? String(input.playlistImportId) : undefined,
      replacement: input.replacement && typeof input.replacement === 'object' ? input.replacement : undefined,
      queuedAt: normalizeTimestamp(input.queuedAt, now),
      retryCount: 0,
      createdAt: now, updatedAt: now,
    }
    tasks.set(key, task)
    added.push(task)
  }
  saveNow()
  void processQueue()
  return added.map(task => getPublicTask(task))
}

export const list = (username: string) => {
  username = assertConfiguredQueueUser(username)
  return Array.from(tasks.values())
    .filter(task => task.username === username)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(task => getPublicTask(task))
}

export const pause = (username: string, id?: string) => {
  username = assertConfiguredQueueUser(username)
  for (const task of tasks.values()) {
    if (task.username !== username || (id && task.id !== id)) continue
    if (!['waiting', 'downloading', 'tagging'].includes(task.status)) continue
    task.status = 'paused'
    task.speed = 0
    task.errorMsg = '已暂停'
    task.updatedAt = Date.now()
    controllers.get(taskMapKey(username, task.id))?.abort()
  }
  saveNow()
}

export const resume = (username: string, id?: string, replacement?: any) => {
  username = assertConfiguredQueueUser(username)
  for (const task of tasks.values()) {
    if (task.username !== username || (id && task.id !== id)) continue
    if (task.status !== 'paused' && task.status !== 'error') continue
    if (replacement && typeof replacement === 'object' && (replacement.source || replacement.songmid || replacement.id || replacement.name || replacement.title)) {
      const source = String(replacement.source || task.songInfo?.source || '').trim()
      task.songInfo = {
        ...task.songInfo,
        ...replacement,
        source,
        id: replacement.id ?? replacement.songmid ?? task.songInfo?.id,
        songmid: replacement.songmid ?? replacement.sourceId ?? replacement.id ?? task.songInfo?.songmid,
        name: replacement.name ?? replacement.title ?? task.songInfo?.name,
        singer: replacement.singer ?? replacement.artist ?? task.songInfo?.singer,
        albumName: replacement.albumName ?? replacement.album ?? task.songInfo?.albumName,
        interval: replacement.interval ?? replacement.duration ?? task.songInfo?.interval,
      }
      task.songKey = fileCache.normalizeSongId(task.songInfo) + '_' + task.requestedQuality
    }
    task.status = 'waiting'
    task.progress = 0
    task.total = 0
    task.received = 0
    task.speed = 0
    task.errorMsg = ''
    task.activeSongKey = undefined
    task.quality = task.requestedQuality
    task.retryCount = (task.retryCount || 0) + 1
    task.startedAt = undefined
    task.completedAt = undefined
    task.failedAt = undefined
    task.queuedAt = Date.now()
    task.updatedAt = Date.now()
  }
  saveNow()
  void processQueue()
}

export const remove = (username: string, options: { id?: string; all?: boolean; completed?: boolean; history?: boolean }) => {
  username = assertConfiguredQueueUser(username)
  for (const [key, task] of tasks) {
    if (task.username !== username) continue
    const shouldRemove = options.all || (options.id && task.id === options.id)
      || (options.completed && ['finished', 'exists'].includes(task.status))
      || (options.history && ['finished', 'exists', 'error', 'paused'].includes(task.status))
    if (!shouldRemove) continue
    controllers.get(key)?.abort()
    tasks.delete(key)
  }
  saveNow()
  void processQueue()
}

export const clearUser = (username: string) => {
  const normalizedUsername = tryNormalizeUsername(username)
  if (normalizedUsername) username = normalizedUsername
  for (const [key, task] of tasks) {
    if (task.username !== username) continue
    controllers.get(key)?.abort()
    tasks.delete(key)
  }
  concurrencyByUser.delete(username)
  saveNow()
  void processQueue()
}

export const pruneUsers = () => {
  const invalidUsers = new Set(Array.from(tasks.values())
    .filter(task => !getConfiguredQueueUser(task.username))
    .map(task => task.username))
  for (const username of invalidUsers) clearUser(username)
  for (const username of Array.from(concurrencyByUser.keys())) {
    if (!getConfiguredQueueUser(username)) concurrencyByUser.delete(username)
  }
  saveNow()
}
