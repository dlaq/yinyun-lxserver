import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MusicTagger } from '../src/server/musicTagger'
import { allowsPlayerQueryToken } from '../src/server/apiNamespace'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-file-cache-'))
const previousCwd = process.cwd()
let fileCache: typeof import('../src/server/fileCache')

test.before(async () => {
  process.chdir(root)
  global.lx = {
    dataPath: path.join(root, 'data'),
    config: {},
  } as any
  fileCache = await import('../src/server/fileCache')
})

test.after(() => {
  process.chdir(previousCwd)
  fs.rmSync(root, { recursive: true, force: true })
})

test('does not create a lyric sidecar when no audio file exists', () => {
  const song = { id: 'wy_123', songmid: 123, source: 'wy', name: '测试歌曲', singer: '测试歌手', albumName: '测试专辑' }
  const saved = fileCache.saveLyricCache(song, { lyric: '[00:01.00]歌词' }, 'admin')
  const cacheDir = fileCache.getCacheDir('admin')

  assert.equal(saved, false)
  assert.equal(fs.readdirSync(cacheDir).some(file => file.endsWith('.lrc')), false)
})

test('authenticated media supports HEAD, bounded Range and invalid Range without sending the full file', async () => {
  const filename = 'http-media-test.wav'
  const bytes = Buffer.from('RIFF-audio-fixture')
  fs.writeFileSync(path.join(fileCache.getCacheDir('admin', true), filename), bytes)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (!allowsPlayerQueryToken(url.pathname, req.method) || url.searchParams.get('token') !== 'test-only') {
      res.writeHead(401); res.end(); return
    }
    fileCache.serveCacheFile(req, res, filename, 'admin', 'music')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as import('node:net').AddressInfo
  const url = `http://127.0.0.1:${address.port}/api/v1/player/music/cache/file/admin/${filename}?token=test-only`
  try {
    const head = await fetch(url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(Number(head.headers.get('content-length')), bytes.length)
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    const range = await fetch(url, { headers: { Range: 'bytes=0-1' } })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), `bytes 0-1/${bytes.length}`)
    assert.equal(await range.text(), 'RI')
    const invalid = await fetch(url, { headers: { Range: 'bytes=1000-2000' } })
    assert.equal(invalid.status, 416)
    await invalid.arrayBuffer()
    const unauthenticated = await fetch(url.replace('?token=test-only', ''), { method: 'HEAD' })
    assert.equal(unauthenticated.status, 401)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('batch metadata completion writes Album Artist into the audio tags', async () => {
  const source = path.resolve(previousCwd, 'public/music/assets/medias/filters/bright-hall.wav')
  const filename = 'metadata-batch-test.wav'
  const musicDir = fileCache.getCacheDir('admin', true)
  const target = path.join(musicDir, filename)
  fs.copyFileSync(source, target)

  const stats = fs.statSync(target)
  fileCache.indexManager.update('admin', {
    id: 'wy_metadata_batch_test',
    name: 'Metadata batch test',
    singer: 'Track artist',
    albumArtist: 'Album artist',
    album: 'Test album',
    source: 'wy',
    quality: 'wav',
    filename,
    folder: 'music',
    mtime: stats.mtimeMs,
    size: stats.size,
    ext: 'wav',
  } as any, 'music')

  const result = await fileCache.batchUpdateMetadata([filename], 'admin')
  assert.deepEqual(result, { successCount: 1, failCount: 0 })

  const tagger = new MusicTagger()
  try {
    tagger.loadPath(target)
    assert.equal(tagger.albumArtist, 'Album artist')
  } finally {
    tagger.dispose()
  }
})

test('writes lyrics beside the indexed audio file with its actual quality name', async () => {
  const cacheDir = fileCache.getCacheDir('admin')
  const filename = '盛夏的果实 - 莫文蔚 - flac - 含情莫莫 莫文蔚全精选辑.flac'
  fs.writeFileSync(path.join(cacheDir, filename), Buffer.from('not-a-real-flac'))
  await fileCache.syncCacheIndex('admin', ['cache'])

  const saved = fileCache.saveLyricCache({
    id: '盛夏的果实 - 莫文蔚 - flac - 含情莫莫 莫文蔚全精选辑',
    source: 'unknown',
    name: '盛夏的果实',
    singer: '莫文蔚',
    albumName: '含情莫莫 莫文蔚全精选辑',
  }, { lyric: '[00:01.00]盛夏的果实' }, 'admin')

  assert.equal(saved, true)
  assert.equal(fs.existsSync(path.join(cacheDir, filename.replace(/\.flac$/, '.lrc'))), true)
  assert.equal(fs.existsSync(path.join(cacheDir, '盛夏的果实 - 莫文蔚 - unknown - 含情莫莫 莫文蔚全精选辑.lrc')), false)
})

test('cache index sync removes only generated orphan unknown lyrics', async () => {
  const cacheDir = fileCache.getCacheDir('admin')
  const orphan = path.join(cacheDir, '孤立歌曲 - 歌手 - unknown - 专辑.lrc')
  const userLyric = path.join(cacheDir, '用户歌词.lrc')
  fs.writeFileSync(orphan, '[00:01.00]旧版残留')
  fs.writeFileSync(userLyric, '[00:01.00]保留')

  await fileCache.syncCacheIndex('admin', ['cache'])

  assert.equal(fs.existsSync(orphan), false)
  assert.equal(fs.existsSync(userLyric), true)
})

test('deleting audio also removes its legacy unknown lyric', async () => {
  const cacheDir = fileCache.getCacheDir('admin')
  const filename = '待删除 - 歌手 - flac - 专辑.flac'
  const unknownLyric = path.join(cacheDir, '待删除 - 歌手 - unknown - 专辑.lrc')
  fs.writeFileSync(path.join(cacheDir, filename), Buffer.from('not-a-real-flac'))
  await fileCache.syncCacheIndex('admin', ['cache'])
  fs.writeFileSync(unknownLyric, '[00:01.00]旧版残留')

  const result = fileCache.removeCacheFile(filename, 'admin', 'cache')

  assert.equal(result.deleted, true)
  assert.equal(fs.existsSync(unknownLyric), false)
})
