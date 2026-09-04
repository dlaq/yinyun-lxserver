import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AtomicJsonStore, AtomicJsonStoreError } from '../src/server/atomicJsonStore'

interface State { schemaVersion: 1; revision: number; value: number }
const valid = (value: unknown): value is State => Boolean(
  value && typeof value === 'object' && (value as any).schemaVersion === 1 &&
  Number.isInteger((value as any).revision) && Number.isInteger((value as any).value),
)

const fixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-atomic-store-'))
  const file = path.join(directory, 'state.json')
  const store = new AtomicJsonStore<State>(file, {
    validate: valid,
    createDefault: () => ({ schemaVersion: 1, revision: 0, value: 0 }),
  })
  return { directory, file, store }
}

test('atomic JSON store serializes concurrent updates and increments revision', async () => {
  const { directory, store } = fixture()
  try {
    await Promise.all(Array.from({ length: 25 }, () => store.update(current => ({ ...current, value: current.value + 1 }))))
    const result = await store.read()
    assert.equal(result.value, 25)
    assert.equal(result.revision, 25)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
test('atomic JSON store rejects stale revisions without changing data', async () => {
  const { directory, store } = fixture()
  try {
    await store.read()
    await store.update(current => ({ ...current, value: 1 }), 0)
    await assert.rejects(store.update(current => ({ ...current, value: 2 }), 0), (error: any) => error?.code === 'revision_conflict')
    assert.equal((await store.read()).value, 1)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('atomic JSON store preserves corrupt evidence and restores a valid backup', async () => {
  const { directory, file, store } = fixture()
  try {
    await store.write({ schemaVersion: 1, revision: 0, value: 1 })
    await store.write({ schemaVersion: 1, revision: 1, value: 2 })
    fs.writeFileSync(file, '{broken', 'utf8')
    const restored = await store.read()
    assert.equal(restored.value, 1)
    assert.ok(fs.readdirSync(directory).some(name => name.endsWith('.corrupt')))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('critical atomic JSON store fails closed when main and backup are invalid', async () => {
  const { directory, file, store } = fixture()
  try {
    fs.writeFileSync(file, '{broken', 'utf8')
    fs.writeFileSync(`${file}.bak`, '{also-broken', 'utf8')
    await assert.rejects(store.read(), (error: any) => error instanceof AtomicJsonStoreError && error.code === 'invalid')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
