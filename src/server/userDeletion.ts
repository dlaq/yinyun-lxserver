import fs from 'node:fs'
import path from 'node:path'

export interface DeletionTarget { target: string; root: string }

export interface UserDeletionTargetOptions {
  username: string
  userDirname: string
  userDataPath: string
  userSourcePath: string
  userRoot: string
  dataPath: string
  processRoot: string
}

export const removeExactDeletionTarget = ({ target, root }: DeletionTarget) => {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing unsafe user data target: ${resolvedTarget}`)
  }
  if (!fs.existsSync(resolvedTarget)) return false
  const stat = fs.lstatSync(resolvedTarget)
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(resolvedTarget)
    return true
  }
  const realRoot = fs.realpathSync(resolvedRoot)
  const realTarget = fs.realpathSync(resolvedTarget)
  if (realTarget === realRoot || !realTarget.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Refusing user data target outside storage root: ${realTarget}`)
  }
  fs.rmSync(realTarget, { recursive: true, force: true })
  return true
}

export const getUserDeletionTargets = (options: UserDeletionTargetOptions): DeletionTarget[] => {
  const roots = {
    users: options.userRoot,
    dataCache: path.join(options.dataPath, 'cache'),
    dataMusic: path.join(options.dataPath, 'music'),
    rootCache: path.join(options.processRoot, 'cache'),
    rootMusic: path.join(options.processRoot, 'music'),
    cover: path.join(options.processRoot, 'cover_cache'),
    playlistSync: path.join(options.dataPath, 'playlist-sync'),
    playlistImport: path.join(options.dataPath, 'playlist-import'),
    externalIndex: path.join(options.dataPath, 'external-index'),
  }
  return [
    { target: options.userDataPath, root: roots.users },
    { target: options.userSourcePath, root: path.join(roots.users, 'source') },
    { target: path.join(roots.dataCache, options.username), root: roots.dataCache },
    { target: path.join(roots.dataMusic, options.username), root: roots.dataMusic },
    { target: path.join(roots.rootCache, options.username), root: roots.rootCache },
    { target: path.join(roots.rootMusic, options.username), root: roots.rootMusic },
    { target: path.join(roots.cover, options.username), root: roots.cover },
    { target: path.join(roots.externalIndex, options.username), root: roots.externalIndex },
    { target: path.join(roots.playlistSync, `${options.userDirname}.json`), root: roots.playlistSync },
    { target: path.join(roots.playlistSync, `${options.userDirname}.json.bak`), root: roots.playlistSync },
    { target: path.join(roots.playlistImport, `${options.userDirname}.json`), root: roots.playlistImport },
    { target: path.join(roots.playlistImport, `${options.userDirname}.json.bak`), root: roots.playlistImport },
  ]
}
