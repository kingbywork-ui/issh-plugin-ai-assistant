#!/usr/bin/env node
// 把宿主 Gateway SDK 类型（new-ssh/packages/issh-gateway/src/types.ts）同步为本仓库的 src/sdk-types.ts。
// 插件仓库独立发布，不能引用宿主相对路径；SDK 类型变更后执行：node scripts/sync-sdk-types.mjs [types.ts 路径]
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = process.argv[2] ?? resolve(root, '..', 'new-ssh', 'packages', 'issh-gateway', 'src', 'types.ts')
const target = join(root, 'src', 'sdk-types.ts')
const header = '// 由 scripts/sync-sdk-types.mjs 从 packages/issh-gateway/src/types.ts 同步，请勿手改；SDK 变更后重新执行同步。\n'

const content = await readFile(source, 'utf8')
if (!/export interface PluginGateway\b/.test(content)) throw new Error(`${source} 不是 Gateway SDK 类型文件`)
await writeFile(target, header + content, 'utf8')
console.log(`已同步 ${source} → ${target}`)
