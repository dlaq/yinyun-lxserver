export interface AudioQualityFormat {
  suffix: string
  contentType: string
  bitRate?: number
}

const QUALITY_FORMATS: Record<string, AudioQualityFormat> = {
  master: { suffix: 'flac', contentType: 'audio/flac' },
  atmos_plus: { suffix: 'm4a', contentType: 'audio/mp4' },
  atmos: { suffix: 'm4a', contentType: 'audio/mp4' },
  hires: { suffix: 'flac', contentType: 'audio/flac' },
  flac24bit: { suffix: 'flac', contentType: 'audio/flac' },
  flac: { suffix: 'flac', contentType: 'audio/flac' },
  '320k': { bitRate: 320, suffix: 'mp3', contentType: 'audio/mpeg' },
  '192k': { bitRate: 192, suffix: 'mp3', contentType: 'audio/mpeg' },
  '128k': { bitRate: 128, suffix: 'mp3', contentType: 'audio/mpeg' },
}

export const getAudioQualityFormat = (quality: string): AudioQualityFormat => (
  QUALITY_FORMATS[quality] || QUALITY_FORMATS['128k']
)

const SIZE_FIELDS = ['size', 'fileSize', 'filesize'] as const

export const hasUsableQualityEntry = (
  entry: unknown,
  parseByteSize: (value: unknown) => number | undefined,
) => {
  if (entry == null || entry === false) return false
  if (typeof entry !== 'object') return true

  const record = entry as Record<string, unknown>
  const presentSizeFields = SIZE_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(record, field))
  if (!presentSizeFields.length) return true
  return presentSizeFields.some(field => Boolean(parseByteSize(record[field])))
}

export const getUpstreamAudioContentType = (value: unknown, fallback: string) => {
  const contentType = String(value || '').split(';')[0].trim().toLowerCase()
  return contentType.startsWith('audio/') ? contentType : fallback
}

const SUPPORTED_AUDIO_CONTAINERS = new Set(['mp3', 'flac', 'ogg', 'wav', 'mp4', 'ape'])

export const parseAudioDurationSeconds = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? value : 0
  const raw = String(value || '').trim()
  if (!raw) return 0
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  const parts = raw.split(':').map(Number)
  if (parts.some(part => !Number.isFinite(part) || part < 0)) return 0
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

export interface DownloadedAudioValidationInput {
  container: string
  size: number
  expectedDuration?: unknown
  inspectedDurationMs?: number
}

export interface DownloadedAudioValidationResult {
  valid: boolean
  reason?: 'unsupported_container' | 'file_too_small' | 'duration_too_short' | 'payload_too_small_for_duration'
  expectedDurationSeconds: number
  inspectedDurationSeconds: number
  minimumBytes: number
}

/**
 * Reject provider error bodies and short preview payloads before they are
 * renamed, tagged, indexed, or exposed to Songloft.  Eight kbit/s is the
 * lowest standard MP3 bitrate, so the size floor is deliberately conservative
 * for every supported container.  Parsed duration, when available, is the
 * stronger signal and catches a structurally valid preview clip.
 */
export const validateDownloadedAudio = (input: DownloadedAudioValidationInput): DownloadedAudioValidationResult => {
  const container = String(input.container || '').toLowerCase()
  const size = Number.isFinite(input.size) ? Math.max(0, Number(input.size)) : 0
  const expectedDurationSeconds = parseAudioDurationSeconds(input.expectedDuration)
  const inspectedDurationSeconds = Number.isFinite(input.inspectedDurationMs)
    ? Math.max(0, Number(input.inspectedDurationMs) / 1000)
    : 0
  const minimumBytes = expectedDurationSeconds >= 30
    ? Math.max(4_096, Math.floor(expectedDurationSeconds * 1_000))
    : 4_096
  const result = { expectedDurationSeconds, inspectedDurationSeconds, minimumBytes }

  if (!SUPPORTED_AUDIO_CONTAINERS.has(container)) {
    return { valid: false, reason: 'unsupported_container', ...result }
  }
  if (size < 4_096) {
    return { valid: false, reason: 'file_too_small', ...result }
  }
  if (
    expectedDurationSeconds >= 30 &&
    inspectedDurationSeconds > 0 &&
    inspectedDurationSeconds + 30 < expectedDurationSeconds &&
    inspectedDurationSeconds < expectedDurationSeconds * 0.75
  ) {
    return { valid: false, reason: 'duration_too_short', ...result }
  }
  if (expectedDurationSeconds >= 30 && size < minimumBytes) {
    return { valid: false, reason: 'payload_too_small_for_duration', ...result }
  }
  return { valid: true, ...result }
}
