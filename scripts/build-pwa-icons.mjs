import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(rootDir, 'public', 'music', 'assets', 'logo.svg')
const outputDir = path.join(rootDir, 'public', 'music', 'assets', 'icons')

await fs.promises.mkdir(outputDir, { recursive: true })

const renderIcon = async (size, filename) => {
  await sharp(sourcePath)
    .resize(size, size)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(path.join(outputDir, filename))
}

await Promise.all([
  renderIcon(180, 'icon-180.png'),
  renderIcon(192, 'icon-192.png'),
  renderIcon(512, 'icon-512.png'),
])

const maskableInset = 51
const maskableLogoSize = 512 - maskableInset * 2
const maskableLogo = await sharp(sourcePath)
  .resize(maskableLogoSize, maskableLogoSize)
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toBuffer()

await sharp({
  create: {
    width: 512,
    height: 512,
    channels: 4,
    background: '#10b981',
  },
})
  .composite([{ input: maskableLogo, left: maskableInset, top: maskableInset }])
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(path.join(outputDir, 'icon-maskable-512.png'))

console.log(`PWA icons generated in ${path.relative(rootDir, outputDir)}`)
