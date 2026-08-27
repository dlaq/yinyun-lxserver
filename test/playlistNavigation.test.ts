import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const read = (relativePath: string): string => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')

test('local playlist detail owns a history entry and restores its original host on back', () => {
  const manager = read('public/music/js/songlist_manager.js')

  assert.match(manager, /pushDetailHistory\('local', detailState\.id\)/)
  assert.match(manager, /page:\s*'songlist-detail'/)
  assert.match(manager, /isDetailOpen:\s*function \(\)/)
  assert.match(manager, /closeDetail:\s*function \(fromPopState = false\)/)
  assert.match(manager, /window\.history\.back\(\)/)
  assert.match(manager, /const hostParentId = detailState\.hostParentId \|\| \(detailState\.isLocal \? 'view-my-playlists' : 'view-songlist'\)/)
  assert.doesNotMatch(manager, /ensureDetailHost\('view-songlist'\);\s*switchTab\(returnTab\)/)
})

test('local playlist detail releases the closing overlay and ignores a stale back event', () => {
  const manager = read('public/music/js/songlist_manager.js')

  assert.match(manager, /let pendingDetailBack = false/)
  assert.match(manager, /let suppressedDetailPopstates = 0/)
  assert.match(manager, /pendingDetailBack = false[\s\S]*suppressedDetailPopstates \+= 1/)
  assert.match(manager, /classList\.add\('translate-x-full', 'pointer-events-none'\)/)
  assert.match(manager, /style\.pointerEvents = 'none'/)
  assert.match(manager, /fromPopState && suppressedDetailPopstates > 0/)
})

test('browser back delegates local playlist detail before search history handling', () => {
  const app = read('public/music/app.js')
  const start = app.indexOf("window.addEventListener('popstate'")
  const end = app.indexOf('\n});', start)
  const handler = app.slice(start, end)

  assert.ok(start >= 0)
  assert.match(handler, /isLyricViewOpen/)
  assert.match(handler, /SongListManager\?\.isDetailOpen\?\.\(\)/)
  assert.match(handler, /SongListManager\.closeDetail\(true\)/)
  assert.ok(handler.indexOf('SongListManager') < handler.indexOf('search-back-btn'))
})

test('account sync rejects malformed, stale-account, and empty replacement snapshots', () => {
  const app = read('public/music/app.js')

  assert.match(app, /function isAccountListSnapshot\(listData\)/)
  assert.match(app, /Array\.isArray\(listData\.defaultList\)/)
  assert.match(app, /Array\.isArray\(listData\.loveList\)/)
  assert.match(app, /Array\.isArray\(listData\.userList\)/)
  assert.match(app, /existingData\.userList\.length > 0[\s\S]*?nextData\.userList\.length === 0/)
  assert.match(app, /favoritesReloadRequestId\+\+|favoritesReloadRequestId\s*\+=\s*1/)
  assert.match(app, /isCurrentAccountSync\(user, loginEpoch\)/)
  assert.match(app, /canApplyAccountListSnapshot\(listData, currentListData, user\)/)
})

test('network playlist refresh cannot persist a transient empty source response', () => {
  const app = read('public/music/app.js')
  const start = app.indexOf('async function handleRefreshList')
  const end = app.indexOf('\nasync function handleJumpToOriginalList', start)
  const refresh = app.slice(start, end)

  assert.ok(start >= 0)
  assert.match(refresh, /previousList\.length > 0 && newList\.length === 0/)
  assert.match(refresh, /源歌单返回空列表/)
  assert.match(refresh, /const synced = await pushDataChange\(\)/)
  assert.match(refresh, /if \(synced === false\) throw/)
  assert.match(refresh, /current\.list = previousList/)
})

test('returning from a local playlist renders the validated cached account snapshot', () => {
  const app = read('public/music/app.js')

  assert.match(app, /renderMyPlaylists\(getActiveListData\(\)\)/)
  assert.match(app, /function getActiveListData\(\)/)
  assert.match(app, /requestedUser && dataUser && requestedUser !== dataUser/)
  assert.match(app, /const activeData = getActiveListData\(\)/)
})

test('Songloft synchronization protects read-only and duplicated remote targets', () => {
  const api = read('src/server/apiV1.ts')

  assert.match(api, /songloft_playlist_readonly/)
  assert.match(api, /findPlaylistSyncTargetConflict\(/)
  assert.match(api, /songloft_playlist_already_mapped/)
  assert.match(api, /songloftPlaylistLockKey\(remotePlaylistId\)/)
  assert.match(api, /remoteSnapshotWasUnexpectedlyEmpty/)
  assert.match(api, /跳过重排以避免误清空/)
})
