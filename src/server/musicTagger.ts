import fs from 'node:fs'
import { MetaPicture, MusicFile } from 'music-tag-native'

/**
 * Keeps the server's existing synchronous metadata workflow on top of the
 * music-tag-native 1.x MusicFile API.
 */
export class MusicTagger {
    private file: MusicFile | null = null
    private sourcePath: string | null = null
    private sourceBuffer: Uint8Array | null = null

    loadPath(filePath: string) {
        this.sourcePath = filePath
        // music-tag-native 1.x keeps a path-backed native handle alive until
        // garbage collection on Windows. That prevents callers from moving or
        // deleting a file immediately after dispose(). Use a buffer-backed
        // instance on Windows so the wrapper has deterministic file lifetime;
        // Linux keeps the path-backed fast path used by the production image.
        if (process.platform === 'win32') {
            this.sourceBuffer = fs.readFileSync(filePath)
            this.file = MusicFile.loadSync(this.sourceBuffer)
        } else {
            this.sourceBuffer = null
            this.file = MusicFile.loadSync(filePath)
        }
        return this
    }

    get title() { return this.file?.title ?? null }
    set title(value: string | null) { this.requireFile().title = value }

    get artist() { return this.file?.artist ?? null }
    set artist(value: string | null) { this.requireFile().artist = value }

    get album() { return this.file?.album ?? null }
    set album(value: string | null) { this.requireFile().album = value }

    get year() { return this.file?.year ?? null }
    set year(value: number | null) { this.requireFile().year = value }

    get pictures() { return this.file?.pictures ?? null }
    set pictures(value: MetaPicture[] | null) { this.requireFile().pictures = value }

    get lyrics() { return this.file?.lyrics ?? null }
    set lyrics(value: string | null) { this.requireFile().lyrics = value }

    get quality() { return this.file?.quality ?? null }
    get bitRate() { return this.file?.bitRate ?? undefined }
    get sampleRate() { return this.file?.sampleRate ?? undefined }
    get bitDepth() { return this.file?.bitDepth ?? undefined }
    get duration() { return this.file?.duration ?? 0 }

    save() {
        const file = this.requireFile()
        if (this.sourceBuffer && this.sourcePath) {
            const updated = file.saveSync(this.sourceBuffer)
            fs.writeFileSync(this.sourcePath, updated)
            this.sourceBuffer = updated
            return
        }
        file.saveSync()
    }

    dispose() {
        this.file = null
        this.sourceBuffer = null
        this.sourcePath = null
    }

    private requireFile() {
        if (!this.file) throw new Error('Music file has not been loaded')
        return this.file
    }
}

export { MetaPicture }
