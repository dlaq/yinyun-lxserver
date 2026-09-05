import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getAudioQualityFormat,
  getUpstreamAudioContentType,
  hasUsableQualityEntry,
  parseAudioDurationSeconds,
  validateDownloadedAudio,
} from '../src/server/audioQuality'

const parseByteSize = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined
}

test('rejects advertised qualities whose explicit size is empty or zero', () => {
  assert.equal(hasUsableQualityEntry({ size: null }, parseByteSize), false)
  assert.equal(hasUsableQualityEntry({ size: 0 }, parseByteSize), false)
  assert.equal(hasUsableQualityEntry({ filesize: '0' }, parseByteSize), false)
})

test('accepts qualities with a valid size or an explicit availability marker', () => {
  assert.equal(hasUsableQualityEntry({ size: 1_024 }, parseByteSize), true)
  assert.equal(hasUsableQualityEntry({ bitRate: 320 }, parseByteSize), true)
  assert.equal(hasUsableQualityEntry('128k', parseByteSize), true)
})

test('maps actual playback qualities to their real stream formats', () => {
  assert.deepEqual(getAudioQualityFormat('flac'), { suffix: 'flac', contentType: 'audio/flac' })
  assert.deepEqual(getAudioQualityFormat('128k'), { bitRate: 128, suffix: 'mp3', contentType: 'audio/mpeg' })
  assert.equal(getUpstreamAudioContentType('audio/mpeg; charset=binary', 'audio/flac'), 'audio/mpeg')
  assert.equal(getUpstreamAudioContentType('application/octet-stream', 'audio/flac'), 'audio/flac')
})

test('parses provider duration values without confusing clock text and seconds', () => {
  assert.equal(parseAudioDurationSeconds('04:16'), 256)
  assert.equal(parseAudioDurationSeconds('1:02:03'), 3723)
  assert.equal(parseAudioDurationSeconds(186), 186)
  assert.equal(parseAudioDurationSeconds('invalid'), 0)
})

test('rejects a truncated or preview payload before it reaches the local index', () => {
  assert.deepEqual(validateDownloadedAudio({
    container: 'mp3',
    size: 165_433,
    expectedDuration: '04:16',
    inspectedDurationMs: 10_200,
  }), {
    valid: false,
    reason: 'duration_too_short',
    expectedDurationSeconds: 256,
    inspectedDurationSeconds: 10.2,
    minimumBytes: 256_000,
  })

  assert.equal(validateDownloadedAudio({
    container: 'mp3',
    size: 165_433,
    expectedDuration: '04:16',
  }).reason, 'payload_too_small_for_duration')
})

test('accepts a complete low-bitrate file and rejects non-audio payloads', () => {
  assert.equal(validateDownloadedAudio({
    container: 'mp3',
    size: 512_000,
    expectedDuration: 256,
    inspectedDurationMs: 255_500,
  }).valid, true)
  assert.equal(validateDownloadedAudio({
    container: 'unknown',
    size: 5_000_000,
    expectedDuration: 256,
  }).reason, 'unsupported_container')
})
