import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const read = (relativePath: string): string => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')

test('local playlist detail owns a numbered history entry and restores its original host on back', () => {
  const manager = read('public/music/js/songlist_manager.js')

  assert.match(manager, /pushDetailHistory\('local', detailState\.id\)/)
  assert.match(manager, /page:\s*'songlist-detail'/)
  assert.match(manager, /songlistNavigationId:\s*navigationId/)
  assert.match(manager, /isDetailOpen:\s*function \(\)/)
  assert.match(manager, /closeDetail:\s*function \(fromPopState = false\)/)
  assert.match(manager, /pendingBackNavigationId = detailState\.navigationId/)
  assert.match(manager, /beginDetailClose\(\);\s*window\.history\.back\(\)/)
  assert.match(manager, /window\.history\.back\(\)/)
  assert.match(manager, /const hostParentId = detailState\.hostParentId \|\| \(detailState\.isLocal \? 'view-my-playlists' : 'view-songlist'\)/)
  assert.doesNotMatch(manager, /ensureDetailHost\('view-songlist'\);\s*switchTab\(returnTab\)/)
})

test('browser back is settled by the playlist navigation state before generic detail handling', () => {
  const app = read('public/music/app.js')
  const start = app.indexOf("window.addEventListener('popstate'")
  const end = app.indexOf('\n});', start)
  const handler = app.slice(start, end)

  assert.ok(start >= 0)
  assert.match(handler, /isLyricViewOpen/)
  assert.match(handler, /SongListManager\?\.handlePopState\?\.\(e\.state\)/)
  assert.match(handler, /SongListManager\?\.isDetailOpen\?\.\(\)/)
  assert.match(handler, /SongListManager\.closeDetail\(true\)/)
  assert.ok(handler.indexOf('handlePopState') < handler.indexOf('isDetailOpen'))
  assert.ok(handler.indexOf('SongListManager') < handler.indexOf('search-back-btn'))
})

test('a new playlist click waits for the matching back transition instead of being closed by it', () => {
  const manager = read('public/music/js/songlist_manager.js')

  assert.match(manager, /function queueDetailOpen\(kind, payload\)/)
  assert.match(manager, /pendingDetailOpen = \{ kind, payload \}/)
  assert.match(manager, /if \(pendingBackNavigationId !== null \|\| detailPhase !== 'closed' \|\| !pendingDetailOpen\) return/)
  assert.match(manager, /pendingBackNavigationId = null;\s*detailState\.historyPushed = false;\s*openQueuedDetail\(\)/)
  assert.match(manager, /if \(queueDetailOpen\('local', list\)\) return/)
})

test('returning from a local playlist keeps the mounted playlist grid without re-rendering the tab', () => {
  const manager = read('public/music/js/songlist_manager.js')
  const app = read('public/music/app.js')

  assert.match(manager, /function keepReturnTabVisible\(tabId\)/)
  assert.match(manager, /view\.classList\.remove\('hidden', 'opacity-0'\)/)
  assert.match(manager, /if \(!keepReturnTabVisible\('my-playlists'\)\) switchTab\('my-playlists'\)/)
  assert.match(manager, /if \(!keepReturnTabVisible\(returnTab\)\) switchTab\(returnTab\)/)
  assert.match(manager, /detailState\.returnScrollTop = parent \? parent\.scrollTop : 0/)
  assert.match(manager, /if \(parent\) parent\.scrollTop = 0/)
  assert.match(manager, /const detailView = prepareDetailHost\('view-my-playlists'\)/)
  assert.match(manager, /restoreReturnScroll\(returnTab\)/)
  assert.match(app, /function getMyPlaylistRenderSignature\(data\)/)
  assert.match(app, /if \(grid\.dataset\.renderSignature === renderSignature\) return/)
})

test('delayed playback resume restores only the queue and cannot navigate away from the active tab', () => {
  const app = read('public/music/app.js')

  assert.match(app, /window\._pendingResumeQueueListId = state\.listId \|\| 'default'/)
  assert.match(app, /const restoredList = findListById\(data, listId\)/)
  assert.match(app, /currentPlaylist = restoredList/)
  assert.doesNotMatch(app, /window\._pendingResumeListId/)
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

test('background network playlist status patches badges without re-rendering playlists', () => {
  const app = read('public/music/app.js')
  const start = app.indexOf('function applyNetworkListStatusesV162')
  const end = app.indexOf('\nasync function loadNetworkListStatusesV162', start)
  const applyStatuses = app.slice(start, end)

  assert.ok(start >= 0)
  assert.match(applyStatuses, /querySelectorAll\('\[data-network-list-status\]'\)/)
  assert.doesNotMatch(applyStatuses, /renderMyLists\(/)
  assert.match(app, /data-network-list-status=/)
})

test('player and automatic Songloft synchronization are append-only', () => {
  const app = read('public/music/app.js')
  const start = app.indexOf('async function syncSongloftPlaylist')
  const end = app.indexOf('\nfunction scheduleSongloftPlaylistSync', start)
  const sync = app.slice(start, end)

  assert.ok(start >= 0)
  assert.match(sync, /direction: 'push', mode: 'merge'/)
  assert.doesNotMatch(sync, /mode: 'replace'/)
  assert.match(app, /安全追加到 Songloft/)
})
