import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createExternalMusicLibrary,
  getExternalLibraryByLocation,
  getExternalLibraryContainerPath,
  getExternalLocation,
  removeExternalMusicLibrary,
} from '../src/server/externalMusicLibraries'

test('external music libraries are user-scoped and use stable container paths', () => {
  const previous = (global as any).lx
  const previousRoot = process.env.EXTERNAL_MUSIC_ROOT
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-external-library-'))
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-external-root-'))
  process.env.EXTERNAL_MUSIC_ROOT = externalRoot
  fs.mkdirSync(path.join(externalRoot, 'admin', 'bendigequ'), { recursive: true })
  ;(global as any).lx = { dataPath, config: { users: [{ name: 'admin' }] } }

  try {
    const library = createExternalMusicLibrary('admin', 'bendigequ')
    const location = getExternalLocation(library)
    assert.equal(getExternalLibraryContainerPath(library), '/server/external/admin/bendigequ')
    assert.equal(getExternalLibraryByLocation(location, 'admin')?.id, library.id)
    assert.equal(getExternalLibraryByLocation(location, 'other'), null)
    assert.equal(removeExternalMusicLibrary(library.id)?.id, library.id)
    assert.equal(getExternalLibraryByLocation(location, 'admin'), null)
  } finally {
    ;(global as any).lx = previous
    if (previousRoot === undefined) delete process.env.EXTERNAL_MUSIC_ROOT
    else process.env.EXTERNAL_MUSIC_ROOT = previousRoot
    fs.rmSync(dataPath, { recursive: true, force: true })
    fs.rmSync(externalRoot, { recursive: true, force: true })
  }
})

test('external music libraries reject symlinks that escape the read-only root', () => {
  const previous = (global as any).lx
  const previousRoot = process.env.EXTERNAL_MUSIC_ROOT
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-external-library-'))
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-external-root-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-external-outside-'))
  process.env.EXTERNAL_MUSIC_ROOT = externalRoot
  fs.mkdirSync(path.join(externalRoot, 'admin'), { recursive: true })
  fs.symlinkSync(outside, path.join(externalRoot, 'admin', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  ;(global as any).lx = { dataPath, config: { users: [{ name: 'admin' }] } }

  try {
    assert.throws(() => createExternalMusicLibrary('admin', 'escape'), /符号链接/)
  } finally {
    ;(global as any).lx = previous
    if (previousRoot === undefined) delete process.env.EXTERNAL_MUSIC_ROOT
    else process.env.EXTERNAL_MUSIC_ROOT = previousRoot
    fs.rmSync(dataPath, { recursive: true, force: true })
    fs.rmSync(externalRoot, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})
