import crypto from 'node:crypto'
import { normalizeUsername } from '@/utils/username'
import * as fileCache from './fileCache'

export interface SharedLibraryItem extends fileCache.CacheItem {
  libraryOwner: string
  shared: boolean
  readOnly: boolean
  localTrackId: string
}

const configuredUsernames = () => global.lx.config.users.map(user => normalizeUsername(user.name))

const decorate = (
  item: fileCache.CacheItem,
  owner: string,
  requestingUser: string,
  folder?: fileCache.CacheFolder,
): SharedLibraryItem => {
  const resolvedFolder = folder || item.folder
  const identity = `${owner}\0${item.storageLocation || fileCache.getCacheLocation()}\0${resolvedFolder}\0${item.filename}`
  return {
    ...item,
    folder: resolvedFolder,
    libraryOwner: owner,
    shared: owner !== requestingUser,
    readOnly: owner !== requestingUser,
    localTrackId: `local_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
  }
}

const itemKey = (item: SharedLibraryItem) => [
  item.libraryOwner,
  item.folder || 'music',
  item.storageLocation || fileCache.getCacheLocation(),
  item.filename,
].join('\0')

/**
 * Return the authenticated user's private cache together with every configured
 * user's downloaded music. Other users' entries are read-only: callers must
 * continue to route every mutation through the authenticated user's own path.
 */
export const getSharedCacheList = async (requestingUsername: string): Promise<SharedLibraryItem[]> => {
  const requestingUser = normalizeUsername(requestingUsername)
  const owners = configuredUsernames()
  const ownItems = await fileCache.getCacheList(requestingUser)
  const remoteOwners = owners.filter(owner => owner !== requestingUser)
  const remoteItems = await Promise.all(remoteOwners.map(async owner => ({
    owner,
    items: await fileCache.getDownloadedMusicItemsAcrossLocations(owner),
  })))

  const merged = new Map<string, SharedLibraryItem>()
  for (const item of ownItems) {
    const decorated = decorate(item, requestingUser, requestingUser)
    merged.set(itemKey(decorated), decorated)
  }
  for (const group of remoteItems) {
    for (const item of group.items) {
      const decorated = decorate(item, group.owner, requestingUser, 'music')
      merged.set(itemKey(decorated), decorated)
    }
  }
  return Array.from(merged.values())
}

/** Return all persistent music visible to a user, excluding every cache tree. */
export const getSharedDownloadedMusicItems = async (requestingUsername: string): Promise<SharedLibraryItem[]> => {
  const requestingUser = normalizeUsername(requestingUsername)
  const owners = [requestingUser, ...configuredUsernames().filter(owner => owner !== requestingUser)]
  const groups = await Promise.all(owners.map(async owner => ({
    owner,
    items: await fileCache.getDownloadedMusicItemsAcrossLocations(owner),
  })))
  const merged = new Map<string, SharedLibraryItem>()
  for (const group of groups) {
    for (const item of group.items) {
      const decorated = decorate(item, group.owner, requestingUser, 'music')
      merged.set(itemKey(decorated), decorated)
    }
  }
  return Array.from(merged.values())
}

export const canReadLibraryOwner = (
  requestingUsername: string,
  ownerUsername: string,
  folder: fileCache.CacheFolder,
) => {
  const requester = normalizeUsername(requestingUsername)
  const owner = normalizeUsername(ownerUsername)
  if (!configuredUsernames().includes(owner)) return false
  return requester === owner || folder === 'music'
}
