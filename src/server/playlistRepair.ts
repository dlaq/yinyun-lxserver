import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getUserDirname, getUserSpace } from '@/user'
import { normalizeUsername } from '@/utils/username'
import { AdminOperationManager, AdminOperationError, type AdminOperationRecord } from './adminOperations'
import { assertPlaylistData, hashPlaylistData, repairHistoricalDuplicatePlaylists } from './playlistInvariants'

export class PlaylistRepairError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message)
    this.name = 'PlaylistRepairError'
  }
}

const configuredUsername = (value: unknown) => {
  let username: string
  try { username = normalizeUsername(value) } catch { throw new PlaylistRepairError(400, 'invalid_user', '用户名无效') }
  if (!global.lx.config.users.some(user => user.name === username)) {
    throw new PlaylistRepairError(404, 'user_not_found', '用户不存在')
  }
  return username
}

const writeImmutableJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const fd = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  if (process.platform !== 'win32') {
    const directoryFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY)
    try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
  }
}

const getJournal = (operation: AdminOperationRecord) => {
  const journal = operation.journal as any
  if (!journal || typeof journal.username !== 'string') {
    throw new PlaylistRepairError(500, 'repair_journal_invalid', '修复操作日志无效')
  }
  return journal as { username: string; backupPath?: string; beforeHash: string; afterHash: string }
}

export const previewPlaylistRepair = async (
  operations: AdminOperationManager,
  adminSid: string,
  rawUsername: unknown,
) => {
  const username = configuredUsername(rawUsername)
  const current = await getUserSpace(username).listManage.getListData()
  const { report } = repairHistoricalDuplicatePlaylists(current)
  const preview = {
    username,
    ...report,
    changesRequired: report.removedDuplicateRecords > 0,
  }
  const created = await operations.createPreview({
    kind: 'playlist-repair',
    adminSid,
    inputHash: report.beforeHash,
    preview,
    journal: { username, beforeHash: report.beforeHash, afterHash: report.afterHash },
  })
  return { ...created, preview }
}

export const applyPlaylistRepair = async (
  operations: AdminOperationManager,
  adminSid: string,
  body: any,
) => {
  const operationId = String(body?.operationId || '')
  const confirmationToken = String(body?.confirmationToken || '')
  if (!operationId || !confirmationToken) throw new PlaylistRepairError(400, 'confirmation_required', '缺少操作 ID 或确认令牌')

  const publicOperation = await operations.get(operationId, adminSid)
  if (publicOperation.kind !== 'playlist-repair') throw new PlaylistRepairError(400, 'operation_kind_mismatch', '操作类型不匹配')
  const preview = publicOperation.preview as any
  const username = configuredUsername(preview?.username)
  const space = getUserSpace(username)
  const current = await space.listManage.getListData()
  const currentHash = hashPlaylistData(current)
  const consumed = await operations.consumeConfirmation({ operationId, confirmationToken, adminSid, currentInputHash: currentHash })
  const journal = getJournal(consumed)
  const { repaired, report } = repairHistoricalDuplicatePlaylists(current)
  if (report.afterHash !== journal.afterHash) {
    await operations.update(operationId, 'failed', { error: 'repair_output_changed_after_preview' })
    throw new PlaylistRepairError(409, 'repair_preview_stale', '修复结果与预览不一致，请重新预览')
  }
  if (!report.removedDuplicateRecords) {
    const result = { username, changed: false, ...report }
    await operations.update(operationId, 'completed', { result })
    return result
  }

  const backupPath = path.join(
    global.lx.dataPath,
    'data-repair',
    'playlists',
    getUserDirname(username),
    `${operationId}.before.json`,
  )
  writeImmutableJson(backupPath, current)
  await operations.update(operationId, 'applying', { journal: { ...journal, backupPath } })

  try {
    await space.listManage.listDataManage.listDataOverwrite(repaired)
    const snapshotId = await space.listManage.createSnapshot()
    const after = await space.listManage.getListData()
    assertPlaylistData(after)
    const afterHash = hashPlaylistData(after)
    if (afterHash !== report.afterHash) throw new Error('Playlist repair write verification failed')
    const result = { username, changed: true, snapshotId, backupPath, ...report }
    await operations.update(operationId, 'completed', { result })
    return result
  } catch (error: any) {
    try {
      await space.listManage.listDataManage.listDataOverwrite(current, { allowHistoricalDuplicates: true })
      await space.listManage.createSnapshot()
      const restoredHash = hashPlaylistData(await space.listManage.getListData())
      if (restoredHash !== currentHash) throw new Error('Playlist repair rollback verification failed')
      await operations.update(operationId, 'rolled_back', { error: error?.message || String(error) })
    } catch (rollbackError: any) {
      await operations.update(operationId, 'failed', {
        error: `repair_failed_and_rollback_failed:${rollbackError?.message || rollbackError}`,
      })
      throw new PlaylistRepairError(500, 'playlist_repair_rollback_failed', '歌单修复失败且自动回滚未通过验证')
    }
    throw error
  }
}

export const recoverInterruptedPlaylistRepair = async (
  operations: AdminOperationManager,
  operation: AdminOperationRecord,
) => {
  if (operation.kind !== 'playlist-repair' || operation.state !== 'applying') return false
  const journal = getJournal(operation)
  if (!journal.backupPath || !fs.existsSync(journal.backupPath)) {
    await operations.update(operation.id, 'failed', { error: 'interrupted_repair_backup_missing' })
    return false
  }
  try {
    const backup: unknown = JSON.parse(fs.readFileSync(journal.backupPath, 'utf8'))
    assertPlaylistData(backup, { allowHistoricalDuplicates: true })
    const space = getUserSpace(configuredUsername(journal.username))
    await space.listManage.listDataManage.listDataOverwrite(backup, { allowHistoricalDuplicates: true })
    await space.listManage.createSnapshot()
    if (hashPlaylistData(await space.listManage.getListData()) !== journal.beforeHash) {
      throw new Error('Interrupted playlist repair rollback verification failed')
    }
    await operations.update(operation.id, 'rolled_back', { error: 'recovered_after_process_interruption' })
    return true
  } catch (error: any) {
    await operations.update(operation.id, 'failed', { error: `interrupted_repair_recovery_failed:${error?.message || error}` })
    return false
  }
}

export const isAdminOperationError = (error: unknown) => error instanceof AdminOperationError || error instanceof PlaylistRepairError
