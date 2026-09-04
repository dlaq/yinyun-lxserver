import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getUserDirname, getUserSpace } from '@/user'
import { normalizeUsername } from '@/utils/username'
import {
  getAdminOwnedSourceState,
  hashAdminOwnedSourceState,
  listOwnedSourcesForAdmin,
  restoreAdminOwnedSourceState,
  type AdminOwnedSourceState,
} from './customSourceHandlers'
import { AdminOperationManager, type AdminOperationRecord } from './adminOperations'
import { appendSongsStable, assertPlaylistData, hashPlaylistData } from './playlistInvariants'

export class AdminUserSyncError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message)
    this.name = 'AdminUserSyncError'
  }
}

type SourceMode = 'append' | 'overwrite'
type PlaylistMode = 'copy' | 'append' | 'overwrite'
interface BackupRef { username: string; path: string; hash: string }
interface SourceSyncJournal {
  request: { fromUser: string; targetUsers: string[]; mode: SourceMode; sourceIds: string[] }
  expectedHashes: Record<string, string>
  backupRefs?: BackupRef[]
  appliedUsers?: string[]
}
interface PlaylistSyncJournal {
  request: { fromUser: string; toUser: string; sourcePlaylistId: string; targetPlaylistId: string; targetPlaylistName: string; mode: PlaylistMode; operationTime: number }
  desiredHash: string
  backupRefs?: BackupRef[]
  appliedUsers?: string[]
}

const activeUserLocks = new Set<string>()
const clone = <T>(value: T): T => structuredClone(value)
const hashValue = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

const configuredUsername = (value: unknown) => {
  let username: string
  try { username = normalizeUsername(value) } catch { throw new AdminUserSyncError(400, 'invalid_user', '用户名无效') }
  if (!global.lx.config.users.some(user => user.name === username)) {
    throw new AdminUserSyncError(404, 'user_not_found', `用户不存在: ${username}`)
  }
  return username
}

const acquireUserLocks = (usernames: string[]) => {
  const ordered = [...new Set(usernames)].sort((a, b) => a.localeCompare(b))
  if (ordered.some(username => activeUserLocks.has(username))) {
    throw new AdminUserSyncError(409, 'user_sync_in_progress', '目标用户正在执行另一项管理写操作')
  }
  ordered.forEach(username => activeUserLocks.add(username))
  return () => ordered.slice().reverse().forEach(username => activeUserLocks.delete(username))
}

const writeImmutableJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const fd = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  if (process.platform !== 'win32') {
    const directoryFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY)
    try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
  }
}

const backupPath = (operationId: string, username: string, kind: 'sources' | 'playlists') => path.join(
  global.lx.dataPath, 'admin-operations', 'backups', operationId, `${kind}-${getUserDirname(username)}.json`,
)

const readBackup = <T>(ref: BackupRef): T => {
  if (!fs.existsSync(ref.path)) throw new Error(`Operation backup missing for ${ref.username}`)
  const value: T = JSON.parse(fs.readFileSync(ref.path, 'utf8'))
  if (hashValue(value) !== ref.hash) throw new Error(`Operation backup hash mismatch for ${ref.username}`)
  return value
}

export const getAdminUserSyncInventory = async (rawUsername: unknown) => {
  const username = configuredUsername(rawUsername)
  const listData = await getUserSpace(username).listManage.getListData()
  return {
    username,
    sources: listOwnedSourcesForAdmin(username),
    playlists: listData.userList.map(playlist => ({ id: playlist.id, name: playlist.name, trackCount: playlist.list?.length || 0 })),
  }
}

const normalizeSourceRequest = (body: any) => {
  const fromUser = configuredUsername(body?.fromUser)
  const rawTargets = Array.isArray(body?.targetUsers) ? body.targetUsers : []
  const targetUsers = [...new Set<string>(rawTargets.map(configuredUsername))]
    .filter(username => username !== fromUser)
    .sort((a, b) => a.localeCompare(b))
  if (!targetUsers.length) throw new AdminUserSyncError(400, 'target_user_required', '至少选择一个不同的目标用户')
  const mode: SourceMode | null = body?.mode === 'append' ? 'append' : body?.mode === 'overwrite' ? 'overwrite' : null
  if (!mode) throw new AdminUserSyncError(400, 'invalid_mode', '模式必须是追加或覆盖')
  const sourceState = getAdminOwnedSourceState(fromUser)
  const allIds = new Set(sourceState.sources.map(item => item.metadata.id))
  const sourceIds = body?.sourceIds == null
    ? sourceState.order.filter(id => allIds.has(id))
    : Array.isArray(body.sourceIds)
      ? [...new Set<string>(body.sourceIds.map((id: unknown) => String(id || '').trim()).filter(Boolean))]
      : []
  if (!sourceIds.length) throw new AdminUserSyncError(400, 'source_required', '至少选择一个源')
  for (const id of sourceIds) if (!allIds.has(id)) throw new AdminUserSyncError(404, 'source_not_found', `源不存在: ${id}`)
  return { fromUser, targetUsers, mode, sourceIds, sourceState }
}

const buildSourceTarget = (sourceState: AdminOwnedSourceState, targetState: AdminOwnedSourceState, sourceIds: string[], mode: SourceMode) => {
  const selected = sourceIds.map(id => clone(sourceState.sources.find(item => item.metadata.id === id)!))
  // Ownership copies do not inherit the source owner's sharing ACL.
  selected.forEach(item => { item.sharedUsers = [] })
  const previousById = new Map(targetState.sources.map(item => [item.metadata.id, item]))
  const incomingIds = new Set(selected.map(item => item.metadata.id))
  const sources = mode === 'overwrite'
    ? selected
    : [...clone(targetState.sources), ...selected.filter(item => !previousById.has(item.metadata.id))]
  const nextIds = new Set(sources.map(item => item.metadata.id))
  const order = mode === 'overwrite'
    ? sourceState.order.filter(id => nextIds.has(id))
    : [...targetState.order.filter(id => nextIds.has(id)), ...sourceState.order.filter(id => incomingIds.has(id) && !previousById.has(id))]
  const next: AdminOwnedSourceState = { username: targetState.username, sources, order }
  return {
    next,
    summary: {
      targetUser: targetState.username,
      added: selected.filter(item => !previousById.has(item.metadata.id)).length,
      overwritten: mode === 'overwrite' ? selected.filter(item => previousById.has(item.metadata.id)).length : 0,
      kept: mode === 'overwrite' ? 0 : targetState.sources.length,
      conflicts: mode === 'append' ? selected.filter(item => previousById.has(item.metadata.id)).length : 0,
      deleted: mode === 'overwrite' ? targetState.sources.filter(item => !incomingIds.has(item.metadata.id)).length : 0,
      afterTotal: sources.length,
    },
  }
}

const calculateSourcePreview = (body: any) => {
  const request = normalizeSourceRequest(body)
  const targets = request.targetUsers.map(username => getAdminOwnedSourceState(username))
  const plans = targets.map(target => buildSourceTarget(request.sourceState, target, request.sourceIds, request.mode))
  const normalized = { fromUser: request.fromUser, targetUsers: request.targetUsers, mode: request.mode, sourceIds: request.sourceIds }
  const inputHash = hashValue({
    request: normalized,
    sourceHash: hashAdminOwnedSourceState(request.sourceState),
    targetHashes: targets.map(target => [target.username, hashAdminOwnedSourceState(target)]),
  })
  return { request: normalized, targets, plans, inputHash }
}

export const previewAdminSourceSync = async (operations: AdminOperationManager, adminSid: string, body: any) => {
  const calculated = calculateSourcePreview(body)
  const expectedHashes = Object.fromEntries(calculated.plans.map(plan => [plan.next.username, hashAdminOwnedSourceState(plan.next)]))
  const preview = {
    ...calculated.request,
    sourceCount: calculated.request.sourceIds.length,
    targets: calculated.plans.map(plan => plan.summary),
    destructive: calculated.request.mode === 'overwrite' && calculated.plans.some(plan => plan.summary.deleted > 0),
  }
  const journal: SourceSyncJournal = { request: calculated.request, expectedHashes }
  const created = await operations.createPreview({ kind: 'source-sync', adminSid, inputHash: calculated.inputHash, preview, journal })
  return { ...created, preview }
}

export const applyAdminSourceSync = async (operations: AdminOperationManager, adminSid: string, body: any) => {
  const operationId = String(body?.operationId || '')
  const confirmationToken = String(body?.confirmationToken || '')
  if (!operationId || !confirmationToken) throw new AdminUserSyncError(400, 'confirmation_required', '缺少操作 ID 或确认令牌')
  const publicOperation = await operations.get(operationId, adminSid)
  if (publicOperation.kind !== 'source-sync') throw new AdminUserSyncError(400, 'operation_kind_mismatch', '操作类型不匹配')
  const journal = publicOperation.journal as SourceSyncJournal
  const release = acquireUserLocks(journal.request.targetUsers.map(configuredUsername))
  try {
    // Re-read source and every target only after the complete ordered lock set
    // is held. This closes the pre-lock stale-preview window between hashing
    // and confirmation consumption.
    const calculated = calculateSourcePreview(journal.request)
    await operations.consumeConfirmation({ operationId, confirmationToken, adminSid, currentInputHash: calculated.inputHash })
    const refs = calculated.targets.map(target => {
      const ref: BackupRef = { username: target.username, path: backupPath(operationId, target.username, 'sources'), hash: hashValue(target) }
      writeImmutableJson(ref.path, target)
      return ref
    })
    const applyingJournal: SourceSyncJournal = { ...journal, backupRefs: refs, appliedUsers: [] }
    await operations.update(operationId, 'applying', { journal: applyingJournal })
    const applied: string[] = []
    try {
      for (const plan of calculated.plans) {
        // Journal the target before its first mutation. A process exit inside
        // restoreAdminOwnedSourceState must still restore this exact backup.
        applied.push(plan.next.username)
        applyingJournal.appliedUsers = [...applied]
        await operations.update(operationId, 'applying', { journal: applyingJournal })
        await restoreAdminOwnedSourceState(plan.next)
        if (hashAdminOwnedSourceState(getAdminOwnedSourceState(plan.next.username)) !== journal.expectedHashes[plan.next.username]) {
          throw new Error(`Source write verification failed for ${plan.next.username}`)
        }
      }
      const result = { ...calculated.request, targets: calculated.plans.map(plan => plan.summary), committed: true }
      await operations.update(operationId, 'completed', { journal: applyingJournal, result })
      return result
    } catch (error: any) {
      const rollbackErrors: string[] = []
      for (const username of [...applied].reverse()) {
        try {
          const ref = refs.find(item => item.username === username)!
          const state = readBackup<AdminOwnedSourceState>(ref)
          await restoreAdminOwnedSourceState(state)
          if (hashAdminOwnedSourceState(getAdminOwnedSourceState(username)) !== hashAdminOwnedSourceState(state)) throw new Error('verification failed')
        } catch (rollbackError: any) { rollbackErrors.push(`${username}:${rollbackError?.message || rollbackError}`) }
      }
      if (rollbackErrors.length) {
        await operations.update(operationId, 'failed', { journal: applyingJournal, error: `sync_failed_and_rollback_failed:${rollbackErrors.join(';')}` })
        throw new AdminUserSyncError(500, 'source_sync_rollback_failed', '音源同步失败，且部分目标自动恢复未通过验证')
      }
      await operations.update(operationId, 'rolled_back', { journal: applyingJournal, error: error?.message || String(error) })
      throw new AdminUserSyncError(500, 'source_sync_failed', `音源同步失败，所有已写目标已恢复: ${error?.message || error}`)
    }
  } finally { release() }
}

const normalizePlaylistRequest = (body: any) => {
  const fromUser = configuredUsername(body?.fromUser)
  const toUser = configuredUsername(body?.toUser)
  const sourcePlaylistId = String(body?.sourcePlaylistId || '').trim()
  if (!sourcePlaylistId) throw new AdminUserSyncError(400, 'source_playlist_required', '请选择源歌单')
  const requestedTargetId = String(body?.targetPlaylistId || '').trim()
  const mode: PlaylistMode = body?.mode === 'overwrite' ? 'overwrite' : body?.mode === 'append' ? 'append' : 'copy'
  if (mode !== 'copy' && !requestedTargetId) throw new AdminUserSyncError(400, 'target_playlist_required', '追加或覆盖必须指定目标歌单')
  if (mode === 'copy' && requestedTargetId) throw new AdminUserSyncError(400, 'copy_target_forbidden', '复制为新歌单时不能指定已有目标歌单')
  if (fromUser === toUser && sourcePlaylistId === requestedTargetId) throw new AdminUserSyncError(400, 'same_playlist', '源歌单与目标歌单不能相同')
  const operationTime = Number.isFinite(body?.operationTime) ? Number(body.operationTime) : Date.now()
  return { fromUser, toUser, sourcePlaylistId, targetPlaylistId: requestedTargetId, targetPlaylistName: String(body?.targetPlaylistName || '').trim().slice(0, 100), mode, operationTime }
}

const makeUniquePlaylistName = (data: LX.Sync.List.ListData, requested: string) => {
  const existing = new Set(data.userList.map(item => item.name.normalize('NFKC').trim().toLocaleLowerCase()))
  const base = requested.trim().slice(0, 100) || '同步歌单'
  let name = base
  let suffix = 2
  while (existing.has(name.normalize('NFKC').trim().toLocaleLowerCase())) name = `${base} (${suffix++})`.slice(0, 100)
  return name
}

const calculatePlaylistPreview = async (body: any, resolvedTargetId?: string) => {
  const request = normalizePlaylistRequest(body)
  const sourceData = await getUserSpace(request.fromUser).listManage.getListData()
  const targetData = await getUserSpace(request.toUser).listManage.getListData()
  assertPlaylistData(sourceData)
  assertPlaylistData(targetData)
  const sourcePlaylist = sourceData.userList.find(item => item.id === request.sourcePlaylistId)
  if (!sourcePlaylist) throw new AdminUserSyncError(404, 'source_playlist_not_found', '源歌单不存在')
  const sourceSongs = clone(sourcePlaylist.list || []).map(song => {
    const local = song as LX.Music.MusicInfo & { _localFilename?: string; _localOwner?: string }
    return local._localFilename && !local._localOwner ? { ...local, _localOwner: request.fromUser } : local
  })
  const targetPlaylist = request.targetPlaylistId ? targetData.userList.find(item => item.id === request.targetPlaylistId) : undefined
  if (request.targetPlaylistId && !targetPlaylist) throw new AdminUserSyncError(404, 'target_playlist_not_found', '目标歌单不存在')
  if (request.mode === 'overwrite' && sourceSongs.length === 0 && (targetPlaylist?.list.length || 0) > 0) {
    throw new AdminUserSyncError(409, 'empty_source_playlist', '空源歌单不得覆盖非空目标歌单')
  }
  const desired = clone(targetData)
  const newTargetId = request.mode === 'copy' ? (resolvedTargetId || `admin_sync_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`) : request.targetPlaylistId
  let afterSongs: LX.Music.MusicInfo[]
  let added = 0
  let skipped = 0
  if (request.mode === 'copy') {
    afterSongs = clone(sourceSongs)
    added = afterSongs.length
    desired.userList.push({
      id: newTargetId,
      name: makeUniquePlaylistName(targetData, request.targetPlaylistName || sourcePlaylist.name),
      locationUpdateTime: request.operationTime,
      coverSongId: sourcePlaylist.coverSongId,
      coverUrl: sourcePlaylist.coverUrl,
      list: afterSongs,
    })
  } else {
    const desiredTarget = desired.userList.find(item => item.id === request.targetPlaylistId)!
    if (request.mode === 'append') {
      afterSongs = appendSongsStable(desiredTarget.list as any[], sourceSongs as any[]) as LX.Music.MusicInfo[]
      added = afterSongs.length - desiredTarget.list.length
      skipped = sourceSongs.length - added
    } else {
      afterSongs = clone(sourceSongs)
      added = afterSongs.length
    }
    desiredTarget.list = afterSongs
    desiredTarget.locationUpdateTime = request.operationTime
  }
  assertPlaylistData(desired)
  const normalizedRequest = { ...request, targetPlaylistId: newTargetId }
  const inputHash = hashValue({ request, sourceHash: hashPlaylistData(sourceData), targetHash: hashPlaylistData(targetData) })
  return {
    request: normalizedRequest, targetData, desired, inputHash,
    summary: {
      fromUser: request.fromUser, toUser: request.toUser, mode: request.mode,
      sourcePlaylistId: request.sourcePlaylistId, sourcePlaylistName: sourcePlaylist.name,
      targetPlaylistId: newTargetId, targetPlaylistName: desired.userList.find(item => item.id === newTargetId)?.name,
      sourceTrackCount: sourceSongs.length, beforeTrackCount: targetPlaylist?.list.length || 0,
      afterTrackCount: afterSongs.length, added, skipped,
      removed: request.mode === 'overwrite' ? Math.max(0, (targetPlaylist?.list.length || 0) - afterSongs.length) : 0,
      created: request.mode === 'copy',
    },
  }
}

export const previewAdminPlaylistSync = async (operations: AdminOperationManager, adminSid: string, body: any) => {
  const calculated = await calculatePlaylistPreview(body)
  const journal: PlaylistSyncJournal = { request: calculated.request, desiredHash: hashPlaylistData(calculated.desired) }
  const created = await operations.createPreview({ kind: 'playlist-sync', adminSid, inputHash: calculated.inputHash, preview: calculated.summary, journal })
  return { ...created, preview: calculated.summary }
}

export const applyAdminPlaylistSync = async (operations: AdminOperationManager, adminSid: string, body: any) => {
  const operationId = String(body?.operationId || '')
  const confirmationToken = String(body?.confirmationToken || '')
  if (!operationId || !confirmationToken) throw new AdminUserSyncError(400, 'confirmation_required', '缺少操作 ID 或确认令牌')
  const publicOperation = await operations.get(operationId, adminSid)
  if (publicOperation.kind !== 'playlist-sync') throw new AdminUserSyncError(400, 'operation_kind_mismatch', '操作类型不匹配')
  const journal = publicOperation.journal as PlaylistSyncJournal
  const release = acquireUserLocks([journal.request.toUser])
  try {
    const originalRequest = { ...journal.request, targetPlaylistId: journal.request.mode === 'copy' ? '' : journal.request.targetPlaylistId }
    const calculated = await calculatePlaylistPreview(originalRequest, journal.request.targetPlaylistId)
    if (hashPlaylistData(calculated.desired) !== journal.desiredHash) throw new AdminUserSyncError(409, 'preview_stale', '目标结果与预览不一致，请重新预览')
    await operations.consumeConfirmation({ operationId, confirmationToken, adminSid, currentInputHash: calculated.inputHash })
    const ref: BackupRef = { username: journal.request.toUser, path: backupPath(operationId, journal.request.toUser, 'playlists'), hash: hashValue(calculated.targetData) }
    writeImmutableJson(ref.path, calculated.targetData)
    const applyingJournal: PlaylistSyncJournal = { ...journal, backupRefs: [ref], appliedUsers: [] }
    await operations.update(operationId, 'applying', { journal: applyingJournal })
    const target = getUserSpace(journal.request.toUser)
    try {
      // Persist intent before the first in-memory playlist mutation so startup
      // recovery covers exits between overwrite and snapshot creation.
      applyingJournal.appliedUsers = [journal.request.toUser]
      await operations.update(operationId, 'applying', { journal: applyingJournal })
      await target.listManage.listDataManage.listDataOverwrite(calculated.desired)
      await target.listManage.createSnapshot()
      const actual = await target.listManage.getListData()
      assertPlaylistData(actual)
      if (hashPlaylistData(actual) !== journal.desiredHash) throw new Error('Playlist write verification failed')
      const result = { ...calculated.summary, committed: true }
      await operations.update(operationId, 'completed', { journal: applyingJournal, result })
      return result
    } catch (error: any) {
      try {
        const backup = readBackup<LX.Sync.List.ListData>(ref)
        assertPlaylistData(backup)
        await target.listManage.listDataManage.listDataOverwrite(backup)
        await target.listManage.createSnapshot()
        if (hashPlaylistData(await target.listManage.getListData()) !== hashPlaylistData(backup)) throw new Error('verification failed')
        await operations.update(operationId, 'rolled_back', { journal: applyingJournal, error: error?.message || String(error) })
      } catch (rollbackError: any) {
        await operations.update(operationId, 'failed', { journal: applyingJournal, error: `sync_failed_and_rollback_failed:${rollbackError?.message || rollbackError}` })
        throw new AdminUserSyncError(500, 'playlist_sync_rollback_failed', '歌单同步失败，且目标自动恢复未通过验证')
      }
      throw new AdminUserSyncError(500, 'playlist_sync_failed', `歌单同步失败，目标已恢复: ${error?.message || error}`)
    }
  } finally { release() }
}

export const recoverInterruptedAdminUserSync = async (operations: AdminOperationManager, operation: AdminOperationRecord) => {
  if (operation.state !== 'applying' || !['source-sync', 'playlist-sync'].includes(operation.kind)) return false
  const journal = operation.journal as SourceSyncJournal | PlaylistSyncJournal
  const refs = Array.isArray(journal?.backupRefs) ? journal.backupRefs : []
  const applied = Array.isArray(journal?.appliedUsers) ? journal.appliedUsers : []
  if (!refs.length) {
    await operations.update(operation.id, 'failed', { error: 'interrupted_sync_backup_missing', journal })
    return false
  }
  const release = acquireUserLocks(applied.length ? applied : refs.map(item => item.username))
  try {
    for (const username of [...applied].reverse()) {
      const ref = refs.find(item => item.username === username)
      if (!ref) throw new Error(`Backup reference missing for ${username}`)
      if (operation.kind === 'source-sync') {
        const state = readBackup<AdminOwnedSourceState>(ref)
        await restoreAdminOwnedSourceState(state)
        if (hashAdminOwnedSourceState(getAdminOwnedSourceState(username)) !== hashAdminOwnedSourceState(state)) throw new Error(`Source recovery verification failed for ${username}`)
      } else {
        const data = readBackup<LX.Sync.List.ListData>(ref)
        assertPlaylistData(data)
        const target = getUserSpace(username)
        await target.listManage.listDataManage.listDataOverwrite(data)
        await target.listManage.createSnapshot()
        if (hashPlaylistData(await target.listManage.getListData()) !== hashPlaylistData(data)) throw new Error(`Playlist recovery verification failed for ${username}`)
      }
    }
    await operations.update(operation.id, 'rolled_back', { journal, error: 'recovered_after_process_interruption' })
    return true
  } catch (error: any) {
    await operations.update(operation.id, 'failed', { journal, error: `interrupted_sync_recovery_failed:${error?.message || error}` })
    return false
  } finally { release() }
}

export const syncAdminSources = async (_body?: unknown) => {
  throw new AdminUserSyncError(409, 'preview_required', '请先预览音源同步，再使用一次性确认令牌执行')
}
export const syncAdminPlaylist = async (_body?: unknown) => {
  throw new AdminUserSyncError(409, 'preview_required', '请先预览歌单同步，再使用一次性确认令牌执行')
}
