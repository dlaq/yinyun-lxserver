import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-shared-library-'))
const previousCwd = process.cwd()
let fileCache: typeof import('../src/server/fileCache')
let sharedLibrary: typeof import('../src/server/sharedLocalLibrary')

test.before(async () => {
  process.chdir(root)
  global.lx = {
    dataPath: path.join(root, 'data'),
    config: {
      users: [
        { name: 'admin', password: 'secret' },
        { name: 'newbie', password: 'secret' },
      ],
    },
  } as any
  fileCache = await import('../src/server/fileCache')
  sharedLibrary = await import('../src/server/sharedLocalLibrary')
})

test.after(() => {
  process.chdir(previousCwd)
  fs.rmSync(root, { recursive: true, force: true })
})

test('new users can read every persistent local-music tree but not another user cache', async () => {
  const adminMusic = fileCache.getCacheDir('admin', true)
  const adminCache = fileCache.getCacheDir('admin', false)
  fs.writeFileSync(path.join(adminMusic, 'Shared Song - Artist - 320k - Album.mp3'), Buffer.from('audio'))
  fs.writeFileSync(path.join(adminCache, 'Private Cache - Artist - 128k - Album.mp3'), Buffer.from('cache'))
  await fileCache.syncCacheIndex('admin')

  const items = await sharedLibrary.getSharedCacheList('newbie')
  const sharedSong = items.find(item => item.filename.startsWith('Shared Song'))
  assert.ok(sharedSong)
  assert.equal(sharedSong.libraryOwner, 'admin')
  assert.equal(sharedSong.shared, true)
  assert.equal(sharedSong.readOnly, true)
  assert.match(sharedSong.localTrackId, /^local_[a-f0-9]{32}$/)
  assert.equal(items.some(item => item.filename.startsWith('Private Cache')), false)
  assert.equal(sharedLibrary.canReadLibraryOwner('newbie', 'admin', 'music'), true)
  assert.equal(sharedLibrary.canReadLibraryOwner('newbie', 'admin', 'cache'), false)
})
