import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getUserDeletionTargets, removeExactDeletionTarget } from '../src/server/userDeletion'

test('user deletion targets cover persistent and legacy user-owned state only', () => {
  const root = path.resolve(os.tmpdir(), 'yinyun-delete-layout')
  const targets = getUserDeletionTargets({
    username: 'alice',
    userDirname: 'alice-hash',
    userDataPath: path.join(root, 'data', 'users', 'alice-hash'),
    userSourcePath: path.join(root, 'data', 'users', 'source', 'alice-hash'),
    userRoot: path.join(root, 'data', 'users'),
    dataPath: path.join(root, 'data'),
    processRoot: path.join(root, 'server'),
  })
  assert.equal(targets.length, 12)
  assert.ok(targets.some(item => item.target.endsWith(path.join('playlist-sync', 'alice-hash.json.bak'))))
  assert.ok(targets.some(item => item.target.endsWith(path.join('external-index', 'alice'))))
  for (const item of targets) {
    const target = path.resolve(item.target)
    const parent = path.resolve(item.root)
    assert.notEqual(target, parent)
    assert.ok(target.startsWith(`${parent}${path.sep}`))
  }
})

test('user deletion refuses a root or outside path and removes an exact child', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-delete-safe-'))
  const child = path.join(root, 'alice')
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`)
  fs.mkdirSync(child)
  fs.writeFileSync(path.join(child, 'state.json'), '{}', 'utf8')
  try {
    assert.throws(() => removeExactDeletionTarget({ target: root, root }), /unsafe user data target/)
    assert.throws(() => removeExactDeletionTarget({ target: outside, root }), /unsafe user data target/)
    assert.equal(removeExactDeletionTarget({ target: child, root }), true)
    assert.equal(fs.existsSync(child), false)
    assert.equal(removeExactDeletionTarget({ target: child, root }), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
