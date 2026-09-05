import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('playlist owners can preview, replace, clear, and recover in memory without persistent backups', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-playlist-sync-api-'))
  const dataPath = path.join(root, 'data')
  fs.mkdirSync(path.join(dataPath, 'users'), { recursive: true })
  global.lx = {
    dataPath,
    userPath: path.join(dataPath, 'users'),
    logPath: path.join(root, 'logs'),
    staticPath: path.join(root, 'public'),
    config: {
      users: [
        { name: 'admin', password: 'admin-password', isAdmin: true },
        { name: 'alice', password: 'password', isAdmin: false },
      ],
      maxSnapshotNum: 10,
      'list.addMusicLocationType': 'bottom',
      'player.path': '/music',
      'frontend.password': 'admin-secret',
    } as LX.Config,
    saveConfig: () => {},
  }

  const { createApiV1Handler } = await import('../src/server/apiV1')
  const { getUserSpace, releaseUserSpace } = await import('../src/user')
  const manage = getUserSpace('alice').listManage
  await manage.listDataManage.userListCreate({ id: 'safety-source', name: 'Safety Source', position: -1, locationUpdateTime: Date.now() })
  await manage.listDataManage.listMusicOverwrite('safety-source', [{
    id: 'tx_track-1',
    songmid: 'track-1',
    name: 'Track One',
    singer: 'Artist',
    albumName: 'Album',
    interval: '03:00',
    source: 'tx',
  }] as any)
  await manage.createSnapshot()

  const library = [
    { id: 101, title: 'Track One', artist: 'Artist', album: 'Album', duration: 180, source: 'songloft' },
    { id: 102, title: 'Remote Only', artist: 'Artist', album: 'Album', duration: 181, source: 'songloft' },
  ] as any[]
  let remoteIds = [102]
  let remoteName = 'Original Remote Name'
  let failNextReorder = false
  const client = {
    configured: true,
    listPlaylists: async () => [{ id: 9, name: remoteName, song_count: remoteIds.length }],
    listAllSongs: async () => library.map(item => ({ ...item })),
    getPlaylistSongs: async () => remoteIds.map(id => ({ ...library.find(item => item.id === id) })),
    addPlaylistSongs: async (_playlistId: number, ids: number[]) => {
      for (const id of ids) if (!remoteIds.includes(id)) remoteIds.push(id)
    },
    removePlaylistSong: async (_playlistId: number, id: number) => { remoteIds = remoteIds.filter(value => value !== id) },
    reorderPlaylist: async (_playlistId: number, ids: number[]) => {
      if (failNextReorder) {
        failNextReorder = false
        throw new Error('simulated reorder failure')
      }
      assert.deepEqual(new Set(ids), new Set(remoteIds))
      remoteIds = [...ids]
    },
    renamePlaylist: async (_playlistId: number, name: string) => { remoteName = name; return { id: 9, name } },
    deletePlaylist: async (_playlistId: number) => {},
  }
  const libraries: Record<'artists' | 'albums', any[]> = { artists: [], albums: [] }
  const handler = createApiV1Handler({
    serverVersion: 'test',
    getAuthSecret: () => 'test-secret',
    getUsers: () => global.lx.config.users,
    isAdminRequest: req => req.headers['x-frontend-auth'] === global.lx.config['frontend.password'],
    isAdminUser: username => Boolean(global.lx.config.users.find(user => user.name === username)?.isAdmin),
    musicSdk: {},
    normalizeSongInfo: value => value,
    resolveSong: async () => null,
    isSourceSupported: () => true,
    getLoadedSources: () => [],
    getLibrary: async (_username, type) => libraries[type],
    saveLibrary: async (_username, type, items) => { libraries[type] = items },
    getLeaderboardBoards: async () => ({ list: [] }),
    getLeaderboardList: async () => ({ list: [] }),
    getSongloftClient: () => client as any,
  })
  const server = http.createServer((req, res) => {
    void handler(req, res, new URL(req.url || '/', 'http://127.0.0.1')).then(handled => {
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const loginResponse = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password' }),
    })
    assert.equal(loginResponse.status, 200)
    const login = await loginResponse.json() as any
    const userHeaders = {
      'Authorization': `Bearer ${login.data.accessToken}`,
      'Content-Type': 'application/json',
    }
    const adminHeaders = { ...userHeaders, 'X-Frontend-Auth': 'admin-secret' }
    const dedicatedAdminHeaders = { 'X-Frontend-Auth': 'admin-secret' }

    const dedicatedAdminDelete = await fetch(`${origin}/api/v1/integration/songloft/playlists/0`, {
      method: 'DELETE',
      headers: dedicatedAdminHeaders,
    })
    assert.equal(dedicatedAdminDelete.status, 400)

    const deniedDelete = await fetch(`${origin}/api/v1/integration/songloft/playlists/9`, {
      method: 'DELETE',
      headers: userHeaders,
    })
    assert.equal(deniedDelete.status, 403)

    global.lx.config.users.find(user => user.name === 'alice')!.isAdmin = true
    const roleDelete = await fetch(`${origin}/api/v1/integration/songloft/playlists/9`, {
      method: 'DELETE',
      headers: userHeaders,
    })
    assert.equal(roleDelete.status, 200)

    const sync = async (body: Record<string, unknown>, admin = true) => {
      const response = await fetch(`${origin}/api/v1/integration/playlists/sync`, {
        method: 'POST',
        headers: admin ? adminHeaders : userHeaders,
        body: JSON.stringify({ yinyunPlaylistId: 'safety-source', ...body }),
      })
      return { response, payload: await response.json() as any }
    }

    const missingTarget = await sync({ direction: 'push', mode: 'replace' })
    assert.equal(missingTarget.response.status, 400)
    assert.equal(missingTarget.payload.error.code, 'playlist_replace_target_required')

    const notPreviewed = await sync({ direction: 'push', mode: 'replace', songloftPlaylistId: 9 })
    assert.equal(notPreviewed.response.status, 409)
    assert.equal(notPreviewed.payload.error.code, 'playlist_replace_confirmation_required')
    assert.deepEqual(remoteIds, [102])
    assert.equal(remoteName, 'Original Remote Name')

    const preview = await sync({ direction: 'push', mode: 'replace', songloftPlaylistId: 9, dryRun: true })
    assert.equal(preview.response.status, 200)
    assert.equal(preview.payload.data.push.preview.addCount, 1)
    assert.equal(preview.payload.data.push.preview.removeCount, 1)
    assert.equal(typeof preview.payload.data.push.confirmationToken, 'string')
    assert.deepEqual(remoteIds, [102])
    assert.equal(remoteName, 'Original Remote Name')

    const wrongToken = await sync({ direction: 'push', mode: 'replace', songloftPlaylistId: 9, replaceConfirmation: 'wrong-token' })
    assert.equal(wrongToken.response.status, 409)
    assert.deepEqual(remoteIds, [102])

    failNextReorder = true
    const rolledBack = await sync({
      direction: 'push',
      mode: 'replace',
      songloftPlaylistId: 9,
      replaceConfirmation: preview.payload.data.push.confirmationToken,
    })
    assert.equal(rolledBack.response.status, 500)
    assert.deepEqual(remoteIds, [102])
    assert.equal(remoteName, 'Original Remote Name')

    const reused = await sync({
      direction: 'push',
      mode: 'replace',
      songloftPlaylistId: 9,
      replaceConfirmation: preview.payload.data.push.confirmationToken,
    })
    assert.equal(reused.response.status, 409)
    assert.equal(reused.payload.error.code, 'playlist_replace_confirmation_required')

    const secondPreview = await sync({ direction: 'push', mode: 'replace', songloftPlaylistId: 9, dryRun: true })
    const completed = await sync({
      direction: 'push',
      mode: 'replace',
      songloftPlaylistId: 9,
      replaceConfirmation: secondPreview.payload.data.push.confirmationToken,
    })
    assert.equal(completed.response.status, 200)
    assert.deepEqual(remoteIds, [101])
    assert.equal(remoteName, 'Safety Source')
    assert.equal(completed.payload.data.push.backupId, null)

    remoteIds.push(102)
    const merged = await sync({ direction: 'push', mode: 'merge' }, false)
    assert.equal(merged.response.status, 200)
    assert.deepEqual(remoteIds, [101, 102])
    assert.deepEqual(merged.payload.data.push.removedIds, [])

    const userPreview = await sync({ direction: 'push', mode: 'replace', songloftPlaylistId: 9, dryRun: true }, false)
    assert.equal(userPreview.response.status, 200)
    assert.equal(userPreview.payload.data.push.preview.removeCount, 1)
    assert.equal(typeof userPreview.payload.data.push.confirmationToken, 'string')

    const userReplacement = await sync({
      direction: 'push',
      mode: 'replace',
      songloftPlaylistId: 9,
      replaceConfirmation: userPreview.payload.data.push.confirmationToken,
    }, false)
    assert.equal(userReplacement.response.status, 200)
    assert.deepEqual(remoteIds, [101])

    await manage.listDataManage.listMusicOverwrite('safety-source', [{
      id: 'tx_track-1', songmid: 'track-1', name: 'Track One', singer: 'Artist', albumName: 'Album', interval: '03:00', source: 'tx',
    }, {
      id: 'tx_missing', songmid: 'missing', name: 'Unavailable', singer: 'Artist', albumName: 'Album', interval: '03:01', source: 'tx',
    }] as any)
    const partialPreview = await sync({ direction: 'push', mode: 'replace', songloftPlaylistId: 9, dryRun: true }, false)
    assert.equal(partialPreview.response.status, 200)
    assert.equal(partialPreview.payload.data.push.preview.sourceTracks, 2)
    assert.equal(partialPreview.payload.data.push.preview.desiredRemoteTracks, 1)
    assert.equal(partialPreview.payload.data.push.preview.unmatchedTracks, 1)
    assert.equal(partialPreview.payload.data.push.unmatched.length, 1)
    const partialReplacement = await sync({
      direction: 'push',
      mode: 'replace',
      songloftPlaylistId: 9,
      replaceConfirmation: partialPreview.payload.data.push.confirmationToken,
    }, false)
    assert.equal(partialReplacement.response.status, 200)
    assert.deepEqual(remoteIds, [101])

    remoteIds.push(102)
    const userPull = await sync({ direction: 'pull', mode: 'merge', songloftPlaylistId: 9 }, false)
    assert.equal(userPull.response.status, 200)
    assert.equal(userPull.payload.data.pull.added, 0)

    await manage.listDataManage.listMusicOverwrite('safety-source', [] as any)
    const clearPreview = await sync({ direction: 'push', mode: 'replace', songloftPlaylistId: 9, dryRun: true }, false)
    assert.equal(clearPreview.response.status, 200)
    assert.equal(clearPreview.payload.data.push.preview.sourceTracks, 0)
    assert.equal(clearPreview.payload.data.push.preview.desiredRemoteTracks, 0)
    assert.equal(clearPreview.payload.data.push.preview.removeCount, 2)
    const cleared = await sync({
      direction: 'push',
      mode: 'replace',
      songloftPlaylistId: 9,
      replaceConfirmation: clearPreview.payload.data.push.confirmationToken,
    }, false)
    assert.equal(cleared.response.status, 200)
    assert.deepEqual(remoteIds, [])
    assert.equal(fs.existsSync(path.join(dataPath, 'playlist-replace-backups')), false)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    releaseUserSpace('alice', true)
    await new Promise(resolve => setTimeout(resolve, 1_100))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
