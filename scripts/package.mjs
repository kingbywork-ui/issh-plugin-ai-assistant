import { createHash } from 'node:crypto'
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf-8'))
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8'))
const dist = join(root, 'dist')
if (packageMetadata.version !== manifest.version) {
    throw new Error(`package.json 版本 ${packageMetadata.version} 与 plugin.json 版本 ${manifest.version} 不一致`)
}
if (manifest.entry !== `index-${manifest.version}.js`) {
    throw new Error(`入口文件名必须包含版本，以避免更新时复用旧模块缓存：index-${manifest.version}.js`)
}
const entryModule = await import(pathToFileURL(join(dist, manifest.entry)).href)
const bundledManifest = entryModule.default?.manifest
if (bundledManifest?.id !== manifest.id || bundledManifest.version !== manifest.version || bundledManifest.entry !== manifest.entry) {
    throw new Error(`构建产物与 plugin.json 不一致：期望 ${manifest.id} v${manifest.version} (${manifest.entry})，实际 ${bundledManifest?.id ?? '无'} v${bundledManifest?.version ?? '无'} (${bundledManifest?.entry ?? '无'})`)
}

await copyFile(join(root, 'plugin.json'), join(dist, 'plugin.json'))

const collected = []
async function walk (dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
            await walk(join(dir, entry.name), rel)
        } else if (entry.isFile()) {
            collected.push(rel)
        }
    }
}
await walk(dist, '')
collected.sort()

const tarball = `${manifest.id}-${manifest.version}.tgz`
const tarballPath = join(root, tarball)

const tar = spawnSync('tar', ['-czf', tarballPath, '-C', dist, ...collected], {
    stdio: 'inherit',
})
if (tar.status !== 0) {
    throw new Error(`tar 打包失败：exit ${tar.status}`)
}

const hash = createHash('sha256').update(await readFile(tarballPath)).digest('hex')
await writeFile(`${tarballPath}.sha256`, `${hash}  ${tarball}\n`, 'utf-8')

console.log(`打包完成：${tarball}`)
console.log(`sha256：${hash}`)
console.log('包含文件：')
for (const file of collected) console.log(`  ${file}`)
