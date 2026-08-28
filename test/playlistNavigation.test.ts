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

test('returning from a local playlist keeps the mounted playlist grid without re-rendering the tab', () => {
  const manager = read('public/music/js/songlist_manager.js')

  assert.match(manager, /function keepReturnTabVisible\(tabId\)/)
  assert.match(manager, /view\.classList\.remove\('hidden', 'opacity-0'\)/)
  assert.match(manager, /if \(!keepReturnTabVisible\('my-playlists'\)\) switchTab\('my-playlists'\)/)
  assert.match(manager, /if \(!keepReturnTabVisible\(returnTab\)\) switchTab\(returnTab\)/)
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
