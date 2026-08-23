import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-admin-user-sync-'))
const userPath = path.join(root, 'users')
const previousNodeEnv = process.env.NODE_ENV
let adminSync: typeof import('../src/server/adminUserSync')
let userModule: typeof import('../src/user')

const song = (id: string, name = id) => ({
  id,
  songmid: id.replace(/^wy_/, ''),
  name,
  singer: 'Artist',
  source: 'wy',
  interval: '03:00',
  meta: { songId: id.replace(/^wy_/, ''), albumName: 'Album' },
}) as any

test.before(async () => {
  process.env.NODE_ENV = 'test'
  fs.mkdirSync(userPath, { recursive: true })
  global.lx = {
    dataPath: root,
    userPath,
    config: {
      users: [
        { name: 'alice', password: 'secret', dataPath: '' },
        { name: 'bob', password: 'secret', dataPath: '' },
      ],
      maxSnapshotNum: 10,
      'list.addMusicLocationType': 'bottom',
    },
  } as any
  userModule = await import('../src/user')
  adminSync = await import('../src/server/adminUserSync')
})

test.after(async () => {
  // Snapshot/server-info writers are intentionally throttled. Let their final
  // writes settle before removing the isolated fixture directory.
  await new Promise(resolve => setTimeout(resolve, 1_100))
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousNodeEnv
  fs.rmSync(root, { recursive: true, force: true })
})

test('administrator source sync appends safely and overwrites only matching source IDs', async () => {
  const aliceDir = path.join(userPath, 'source', 'alice')
  const bobDir = path.join(userPath, 'source', 'bob')
  fs.mkdirSync(aliceDir, { recursive: true })
  fs.mkdirSync(bobDir, { recursive: true })
  const sourceMeta = {
    id: 'safe.js', name: 'Safe Source', version: '2.0.0', author: 'Tester', description: '', homepage: '',
    size: 11, supportedSources: ['kw'], enabled: false, uploadTime: new Date().toISOString(),
    allowUnsafeVM: false, requireUnsafe: false,
  }
  fs.writeFileSync(path.join(aliceDir, 'safe.js'), 'new-content', 'utf8')
  fs.writeFileSync(path.join(aliceDir, 'sources.json'), JSON.stringify([sourceMeta]), 'utf8')
  fs.writeFileSync(path.join(bobDir, 'safe.js'), 'old-content', 'utf8')
  fs.writeFileSync(path.join(bobDir, 'other.js'), 'other-content', 'utf8')
  fs.writeFileSync(path.join(bobDir, 'sources.json'), JSON.stringify([
    { ...sourceMeta, version: '1.0.0' },
    { ...sourceMeta, id: 'other.js', name: 'Other Source' },
  ]), 'utf8')

  const appended = await adminSync.syncAdminSources({
    fromUser: 'alice', targetUsers: ['bob'], sourceIds: ['safe.js'], mode: 'append',
  })
  assert.deepEqual(appended.results[0].skipped, ['safe.js'])
  assert.equal(fs.readFileSync(path.join(bobDir, 'safe.js'), 'utf8'), 'old-content')

  const overwritten = await adminSync.syncAdminSources({
    fromUser: 'alice', targetUsers: ['bob'], sourceIds: ['safe.js'], mode: 'overwrite',
  })
  assert.deepEqual(overwritten.results[0].overwritten, ['safe.js'])
  assert.equal(fs.readFileSync(path.join(bobDir, 'safe.js'), 'utf8'), 'new-content')
  const metadata = JSON.parse(fs.readFileSync(path.join(bobDir, 'sources.json'), 'utf8'))
  assert.equal(metadata.find((item: any) => item.id === 'safe.js').version, '2.0.0')
  assert.equal(metadata.find((item: any) => item.id === 'other.js').name, 'Other Source')
  assert.equal(fs.readFileSync(path.join(bobDir, 'other.js'), 'utf8'), 'other-content')
})

test('administrator playlist sync appends by song ID and protects a populated target from an empty overwrite', async () => {
  const alice = userModule.getUserSpace('alice')
  const bob = userModule.getUserSpace('bob')
  await alice.listManage.listDataManage.userListCreate({ id: 'source', name: 'Source', position: -1, locationUpdateTime: Date.now() })
  await alice.listManage.listDataManage.listMusicOverwrite('source', [
    song('wy_1'),
    song('wy_2'),
    {
      id: 'local_shared_track',
      songmid: 'local_shared_track',
      name: 'Shared Local',
      singer: 'Artist',
      source: 'local',
      _localFilename: 'Shared Local - Artist - flac - Album.flac',
      _localFolder: 'music',
    } as any,
  ])
  await alice.listManage.listDataManage.userListCreate({ id: 'empty', name: 'Empty', position: -1, locationUpdateTime: Date.now() })
  await alice.listManage.createSnapshot()

  await bob.listManage.listDataManage.userListCreate({ id: 'target', name: 'Target', position: -1, locationUpdateTime: Date.now() })
  await bob.listManage.listDataManage.listMusicOverwrite('target', [song('wy_1', 'Existing')])
  await bob.listManage.createSnapshot()

  const appended = await adminSync.syncAdminPlaylist({
    fromUser: 'alice', toUser: 'bob', sourcePlaylistId: 'source', targetPlaylistId: 'target', mode: 'append',
  })
  assert.equal(appended.beforeTrackCount, 1)
  assert.equal(appended.afterTrackCount, 3)
  const target = (await bob.listManage.getListData()).userList.find(item => item.id === 'target')
  assert.deepEqual(target?.list.map(item => item.id), ['wy_1', 'wy_2', 'local_shared_track'])
  assert.equal((target?.list[2] as any)?._localOwner, 'alice')

  await assert.rejects(
    adminSync.syncAdminPlaylist({
      fromUser: 'alice', toUser: 'bob', sourcePlaylistId: 'empty', targetPlaylistId: 'target', mode: 'overwrite',
    }),
    (error: any) => error?.code === 'empty_source_playlist',
  )
  assert.equal((await bob.listManage.getListData()).userList.find(item => item.id === 'target')?.list.length, 3)
})
