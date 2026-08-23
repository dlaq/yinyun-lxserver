import crypto from 'node:crypto'
import { getUserSpace } from '@/user'
import { normalizeUsername } from '@/utils/username'
import { listOwnedSourcesForAdmin, syncOwnedSourcesForAdmin } from './customSourceHandlers'

export class AdminUserSyncError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const activePlaylistCopies = new Set<string>()
const cloneSongs = (songs: LX.Music.MusicInfo[]): LX.Music.MusicInfo[] => JSON.parse(JSON.stringify(songs))

const configuredUsername = (value: unknown) => {
  let username: string
  try { username = normalizeUsername(value) } catch {
    throw new AdminUserSyncError(400, 'invalid_user', '用户名无效')
  }
  if (!global.lx.config.users.some(user => user.name === username)) {
    throw new AdminUserSyncError(404, 'user_not_found', `用户不存在: ${username}`)
  }
  return username
}

export const getAdminUserSyncInventory = async (rawUsername: unknown) => {
  const username = configuredUsername(rawUsername)
  const listData = await getUserSpace(username).listManage.getListData()
  return {
    username,
    sources: listOwnedSourcesForAdmin(username),
    playlists: listData.userList.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      trackCount: Array.isArray(playlist.list) ? playlist.list.length : 0,
    })),
  }
}

export const syncAdminSources = async (body: any) => {
  const fromUser = configuredUsername(body?.fromUser)
  const targetUsers = Array.isArray(body?.targetUsers)
    ? body.targetUsers.map(configuredUsername)
    : []
  try {
    return await syncOwnedSourcesForAdmin(fromUser, targetUsers, body?.mode, body?.sourceIds)
  } catch (error: any) {
    if (error instanceof AdminUserSyncError) throw error
    throw new AdminUserSyncError(400, 'source_sync_failed', error?.message || '音源同步失败')
  }
}

export const syncAdminPlaylist = async (body: any) => {
  const fromUser = configuredUsername(body?.fromUser)
  const toUser = configuredUsername(body?.toUser)
  const sourcePlaylistId = String(body?.sourcePlaylistId || '').trim()
  const targetPlaylistId = String(body?.targetPlaylistId || '').trim()
  const mode = body?.mode === 'overwrite' ? 'overwrite' : body?.mode === 'append' ? 'append' : null
  if (!sourcePlaylistId) throw new AdminUserSyncError(400, 'source_playlist_required', '请选择源歌单')
  if (!mode) throw new AdminUserSyncError(400, 'invalid_mode', '模式必须是追加或覆盖')
  if (fromUser === toUser && sourcePlaylistId === targetPlaylistId) {
    throw new AdminUserSyncError(400, 'same_playlist', '源歌单与目标歌单不能相同')
  }

  const lockKey = `${fromUser}:${sourcePlaylistId}->${toUser}:${targetPlaylistId || 'new'}`
  if (activePlaylistCopies.has(lockKey)) {
    throw new AdminUserSyncError(409, 'playlist_sync_in_progress', '该跨用户歌单同步正在进行中')
  }
  activePlaylistCopies.add(lockKey)
  try {
    const sourceData = await getUserSpace(fromUser).listManage.getListData()
    const sourcePlaylist = sourceData.userList.find(playlist => playlist.id === sourcePlaylistId)
    if (!sourcePlaylist) throw new AdminUserSyncError(404, 'source_playlist_not_found', '源歌单不存在')
    const sourceSongs = cloneSongs(sourcePlaylist.list || []).map(song => {
      const localSong = song as LX.Music.MusicInfo & { _localFilename?: string, _localOwner?: string }
      return localSong._localFilename && !localSong._localOwner
        ? { ...localSong, _localOwner: fromUser }
        : localSong
    })

    const targetSpace = getUserSpace(toUser)
    const targetData = await targetSpace.listManage.getListData()
    let targetPlaylist = targetPlaylistId
      ? targetData.userList.find(playlist => playlist.id === targetPlaylistId)
      : undefined
    if (targetPlaylistId && !targetPlaylist) {
      throw new AdminUserSyncError(404, 'target_playlist_not_found', '目标歌单不存在')
    }
    if (mode === 'overwrite' && sourceSongs.length === 0 && targetPlaylist?.list?.length && body?.allowEmptyOverwrite !== true) {
      throw new AdminUserSyncError(409, 'empty_source_playlist', '源歌单为空，已取消覆盖以保护目标歌单')
    }

    let created = false
    let resolvedTargetId = targetPlaylist?.id || ''
    const previousSongs = targetPlaylist ? cloneSongs(targetPlaylist.list || []) : []
    try {
      if (!targetPlaylist) {
        const existingNames = new Set(targetData.userList.map(playlist => String(playlist.name || '').normalize('NFKC').trim().toLocaleLowerCase()))
        const baseName = String(body?.targetPlaylistName || sourcePlaylist.name || '同步歌单').trim().slice(0, 100) || '同步歌单'
        let name = baseName
        let suffix = 2
        while (existingNames.has(name.normalize('NFKC').trim().toLocaleLowerCase())) name = `${baseName} (${suffix++})`.slice(0, 100)
        resolvedTargetId = `admin_sync_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
        await targetSpace.listManage.listDataManage.userListCreate({
          id: resolvedTargetId,
          name,
          position: -1,
          locationUpdateTime: Date.now(),
        })
        targetPlaylist = (await targetSpace.listManage.getListData()).userList.find(playlist => playlist.id === resolvedTargetId)
        created = true
      }

      if (mode === 'overwrite' || created) {
        await targetSpace.listManage.listDataManage.listMusicOverwrite(resolvedTargetId, sourceSongs)
      } else {
        await targetSpace.listManage.listDataManage.listMusicAdd(resolvedTargetId, sourceSongs, 'bottom')
      }
      await targetSpace.listManage.createSnapshot()
    } catch (error) {
      if (created) await targetSpace.listManage.listDataManage.userListsRemove([resolvedTargetId])
      else await targetSpace.listManage.listDataManage.listMusicOverwrite(resolvedTargetId, previousSongs)
      throw error
    }

    const finalData = await targetSpace.listManage.getListData()
    const finalPlaylist = finalData.userList.find(playlist => playlist.id === resolvedTargetId)
    return {
      fromUser,
      toUser,
      mode,
      sourcePlaylistId,
      targetPlaylistId: resolvedTargetId,
      created,
      sourceTrackCount: sourceSongs.length,
      beforeTrackCount: previousSongs.length,
      afterTrackCount: finalPlaylist?.list?.length || 0,
    }
  } finally {
    activePlaylistCopies.delete(lockKey)
  }
}
