import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
// 测试脚本内所有路径统一使用 / 分隔（与宿主返回的规范路径一致）。
const resolvePath = (specifier) => new URL(specifier, import.meta.url).href.replace(/\\/g, '/')

async function load (path, replace = {}) {
    let source = await readFile(new URL(resolvePath(path)), 'utf8')
    for (const [before, after] of Object.entries(replace)) source = source.split(before).join(after)
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
}
const contextUrl = await load('../src/context.ts')
const skillsUrl = await load('../src/skills.ts', { "from './context'": `from '${contextUrl}'` })
const skills = await import(skillsUrl)

// ---- 技能目录能力检查（skillFs 只做方法存在性检查）----
const { fs: abilityFs } = { fs: { listLocalDir: async () => ({ root: null, entries: [] }), readLocalFile: async () => null } }
assert.equal(skills.skillFs({ gateway: { fs: abilityFs } }).listLocalDir, abilityFs.listLocalDir)
assert.throws(() => skills.skillFs({ gateway: {} }), /不支持读取技能目录/, 'old hosts without fs.listLocalDir get a clear error')
assert.throws(() => skills.skillFs({ gateway: { fs: { listLocalDir: async () => ({ root: null, entries: [] }) } } }), /不支持读取技能目录/)

// ---- 内存目录树 + 假 gateway.fs ----
// 模拟宿主：路径统一 / 分隔、大小写不敏感（Windows），一次只列一层，缺失目录返回空列表。
const ws = String.fromCharCode(92)
const ensure = (value) => value.split(ws).join('/').replace(/\/+$/, '')
const key = (path) => ensure(String(path)).toUpperCase()
const join = (base, name) => `${ensure(base)}/${name}`
const files = new Map()
const put = (path, text) => files.set(key(path), text)
function memoryFs ({ roots, directories, behavior = new Map() }) {
    const dirs = new Map(directories.map(([path, entries]) => [key(path), entries]))
    const special = new Map([...behavior].map(([path, value]) => [key(path), value]))
    const requests = { list: [], read: [], inFlight: 0, maxInFlight: 0 }
    memoryFs.list = (base) => (dirs.get(key(base)) ?? []).map(([name, type]) => ({ name, path: join(base, name), isDir: type === "dir", isFile: type === "file" }))
    const wait = async () => { requests.inFlight++; requests.maxInFlight = Math.max(requests.maxInFlight, requests.inFlight); await new Promise((resolve) => setTimeout(resolve, 5)); requests.inFlight-- }
    const fs = {
        async listLocalDir (base) {
            await wait()
            requests.list.push(base)
            // 不传 root 时宿主依次尝试默认技能目录；这里把占位符映射到 rootB。
            if (base === undefined) return { root: rootB, entries: memoryFs.list(rootB) }
            if (special.get(key(base)) === "denied") throw new Error("访问被拒绝")
            return { root: base, entries: memoryFs.list(base) }
        },
        async readLocalFile (path) {
            await wait()
            requests.read.push(path)
            if (special.get(key(path)) === "null") return null
            const text = files.get(key(path))
            if (text === undefined) throw new Error(`文件不在根目录内：${path}`)
            return text
        },
    }
    return { fs, requests }
}

// ---- 解析（纯函数，无需 gateway）----
const valid = skills.parseSkill([
    '---',
    'name: "pdf-tools"',
    'description: 处理 PDF',
    'disable-model-invocation: true',
    'metadata:',
    '  author: someone',
    '  nested: [a, b]',
    '---',
    '',
    '正文内容',
].join('\n'), '/home/u/skills/pdf.md', '/home/u/skills')
assert.equal(valid.skill.name, 'pdf-tools')
assert.equal(valid.skill.description, '处理 PDF')
assert.equal(valid.skill.disableModelInvocation, true)
assert.equal(valid.skill.body, '正文内容', 'nested YAML is ignored and body starts after frontmatter')
assert.equal(valid.skill.declaredName, 'pdf-tools')
assert.equal(valid.skill.id, '/home/u/skills/pdf.md')

const singleQuoted = skills.parseSkill("---\nname: 'it''s'\ndescription: \"含引号 \\\"x\\\" 的描述\"\n---\nbody", '/s/skills/a.md', '/s/skills')
assert.equal(singleQuoted.skill.name, "it's")
assert.equal(singleQuoted.skill.description, '含引号 "x" 的描述')

const byDir = skills.parseSkill('---\ndescription: 目录名作为名称\n---\n正文', '/r/my-skill/SKILL.md', '/r')
assert.equal(byDir.skill.name, 'my-skill', 'missing name falls back to the Skill.md directory name')
const byFile = skills.parseSkill('---\ndescription: 文件名作为名称\n---', '/r/dir/notes.md', '/r')
assert.equal(byFile.skill.name, 'notes')
const crlf = skills.parseSkill('---\r\nname: crlf\r\ndescription: windows 换行\r\n---\r\n正文', '/r/c.md', '/r')
assert.equal(crlf.skill.name, 'crlf')
assert.equal(crlf.skill.body, '正文')
assert.equal(crlf.skill.disableModelInvocation, false)

const noDesc = skills.parseSkill('---\nname: x\n---\nbody', '/r/x.md', '/r')
assert.equal(noDesc.skill, undefined)
assert.match(noDesc.reason, /description/)
const noFrontmatter = skills.parseSkill('只有正文', '/r/n.md', '/r')
assert.equal(noFrontmatter.skill, undefined)
const emptyDesc = skills.parseSkill('---\nname: x\ndescription:\n  text: nested\n---\nbody', '/r/x.md', '/r')
assert.equal(emptyDesc.skill, undefined, 'a nested-only description is not a valid description')

// ---- 扫描 ----
const rootA = "C:\\Users\\me\\.claude\\skills"
const rootB = "/home/me/skills"
// 超过 100KB 的正文：使用合法 UTF-8 的多字节字符填充。
const longBody = "长".repeat(skills.MAX_SKILL_BODY + 1)
const directories = [
    [rootA, [["pdf-tools", "dir"], ["single.md", "file"], ["nodesc.md", "file"], ["huge", "dir"], ["SKILL.md", "file"], ["empty-dir", "dir"]]],
    [join(rootA, "pdf-tools"), [["SKILL.md", "file"], ["ignore.txt", "file"], [".git", "dir"]]],
    [join(rootA, "huge"), [["SKILL.md", "file"]]],
    [rootB, [["pdf-tools", "dir"], ["other", "dir"], ["binary", "dir"], ["denied", "dir"], ["big-dir", "dir"]]],
    [join(rootB, "pdf-tools"), [["SKILL.md", "file"]]],
    [join(rootB, "other"), [["SKILL.md", "file"]]],
    [join(rootB, "binary"), [["SKILL.md", "file"]]],
    [join(rootB, "big-dir"), Array.from({ length: 500 }, (_, index) => [`f${index}.md`, "file"])],
]
put(join(join(rootA, "pdf-tools"), "SKILL.md"), "---\nname: pdf\ndescription: PDF 处理技能，包含 token=abcdefghijklmnop 之类的值\n---\nPDF 正文 token=SKILL_SECRET_123")
put(join(join(rootA, "huge"), "SKILL.md"), longBody)
put(join(rootA, "single.md"), "---\nname: single\ndescription: 单文件技能\n---\n单文件正文")
put(join(rootA, "nodesc.md"), "---\nname: nodesc\n---\nbody")
put(join(rootB, "pdf-tools/SKILL.md"), "---\nname: pdf\ndescription: 另一个同名技能\n---\nB 正文")
put(join(rootB, "other/SKILL.md"), "---\nname: other\ndescription:   " + "长描述".repeat(150) + "\n---\nother")
const behavior = new Map([[join(rootB, "denied"), "denied"], [join(rootB, "binary/SKILL.md"), "null"], ["/missing/root", "denied"]])
const { fs, requests } = memoryFs({ roots: [rootA, rootB], directories, behavior })
const scanned = await skills.scanSkills([rootA, rootB, '/missing/root', ''], { fs })
const byName = new Map(scanned.skills.map((skill) => [skill.name, skill]))
const names = scanned.skills.map((skill) => skill.name).sort()
assert.deepEqual(names, ['other', 'pdf (skills)', 'pdf (pdf-tools)', 'single'].sort(), 'all valid skills are found')
assert.ok(scanned.skills.every((skill) => skill.mode === 'off'), 'skills default to disabled')
const pdfA = byName.get('pdf (pdf-tools)')
const pdfB = byName.get('pdf (skills)')
assert.ok(pdfA && pdfB, 'duplicate names are distinguished by source directory')
assert.notEqual(pdfA.id, pdfB.id)
assert.ok(scanned.diagnostics.some((item) => /重复/.test(item.message)), 'duplicate name is diagnosed')
assert.ok(scanned.diagnostics.some((item) => /nodesc\.md/.test(item.filePath) && /description/.test(item.message)), 'missing description is diagnosed with its path')
assert.ok(scanned.diagnostics.some((item) => /SKILL\.md/.test(item.filePath) && /上限/.test(item.message)), 'oversized body is skipped with a diagnostic')
assert.ok(scanned.diagnostics.some((item) => /binary/.test(item.filePath) && /无法读取|非 UTF-8/.test(item.message)), 'null read result is a diagnostic')
assert.ok(scanned.diagnostics.some((item) => /denied/.test(item.filePath) && /访问被拒绝/.test(item.message)), 'a failing subdirectory only records a diagnostic')
assert.ok(scanned.diagnostics.some((item) => item.filePath === '/missing/root'), 'a missing root records a diagnostic')
assert.equal(requests.maxInFlight <= 8, true, 'scan concurrency stays at 8 or below')
assert.ok(requests.list.includes(join(rootA, 'pdf-tools')) && requests.list.includes(`${rootB}/pdf-tools`), 'each top directory is listed to find SKILL.md')
assert.equal(requests.read.some((path) => path.endsWith('ignore.txt') || path.endsWith('.git')), false, 'only candidate markdown files are read')
assert.ok(requests.read.length <= skills.MAX_SKILL_ENTRIES, 'total candidate reads stay within the entry budget')
assert.ok(requests.list.filter((path) => path.startsWith(join(rootB, 'big-dir'))).length <= 1, 'a single level with 500 entries is only read once')
assert.ok(byName.get('other').description.length <= skills.MAX_SKILL_DESCRIPTION + 1, 'directory descriptions are capped at 200 characters')
assert.equal(byName.get('single').body.includes('单文件正文'), true)
assert.equal(pdfA.body.includes('SKILL_SECRET_123'), false, 'skill body is redacted before injection')

const tooManyRoots = await skills.scanSkills(Array.from({ length: 9 }, (_, index) => `/r${index}`), { fs })
assert.equal(tooManyRoots.diagnostics.filter((item) => /最多/.test(item.message)).length, 1, 'root count is capped')

// 根目录列表一次调用失败只记诊断；全部根目录都失败时仍返回空结果而不是抛错。
const manyFailures = await skills.scanSkills(Array.from({ length: 9 }, (_, index) => `/r${index}`), { fs: { listLocalDir: async () => { throw new Error('访问被拒绝') }, readLocalFile: async () => null } })
assert.equal(manyFailures.skills.length, 0)
assert.equal(manyFailures.diagnostics.filter((item) => /无法扫描技能目录/.test(item.message)).length > 0, true)

// 默认目录占位符不传 root，宿主返回的实际路径决定技能 id 与重名后缀。
const listBeforeDefault = requests.list.length
const defaultRoot = await skills.scanSkills([skills.SKILL_DEFAULT_ROOT], { fs })
assert.equal(requests.list[listBeforeDefault], undefined, 'the default root is listed without a root argument')
assert.equal(defaultRoot.skills.some((skill) => skill.root.toLowerCase() === key(rootB).toLowerCase()), true, 'skills under the default root use the host-reported path')
assert.ok(defaultRoot.skills.every((skill) => skill.id.toLowerCase().startsWith(`${key(rootB).toLowerCase()}/`)))
const noDefault = await skills.scanSkills([skills.SKILL_DEFAULT_ROOT], { fs: { listLocalDir: async () => ({ root: null, entries: [] }), readLocalFile: async () => null } })
assert.ok(noDefault.diagnostics.some((item) => /默认技能目录/.test(item.message)), 'missing default directories are diagnosed, not thrown')

// ---- 模式 → prompt ----
const stored = { [pdfA.id]: 'always', [pdfB.id]: 'on-demand', [byName.get('other').id]: 'on-demand', [byName.get('single').id]: 'off' }
const selection = skills.normalizeSelection(stored)
assert.deepEqual(Object.keys(selection).sort(), [pdfA.id, pdfB.id, byName.get('other').id, byName.get('single').id].sort())
assert.deepEqual(skills.normalizeSelection({ a: 'always', b: 'nope', c: 3 }), { a: 'always' })

const prompt = skills.buildSkillPrompt(scanned.skills, selection)
assert.ok(prompt.text.includes('不是用户本轮指令') && prompt.text.startsWith('技能正文'), 'safety declaration is present')
assert.ok(prompt.text.includes('### 常驻技能：pdf (pdf-tools)'))
assert.ok(prompt.text.includes('PDF 正文'), 'always skill body is inlined')
assert.ok(!prompt.text.includes('B 正文'), 'on-demand body is not inlined')
assert.ok(prompt.text.includes(`- pdf (skills): ${pdfB.description}`), 'on-demand catalog lists name and description')
assert.ok(!prompt.text.includes('single'), 'disabled skills are absent')
assert.deepEqual(prompt.always, ['pdf (pdf-tools)'])
assert.deepEqual([...prompt.onDemand].sort(), ['other', 'pdf (skills)'])
assert.equal(prompt.tool.name, 'load_skill')
assert.equal(prompt.tool.inputSchema.type, 'object')
assert.deepEqual(prompt.tool.inputSchema.required, ['skill'])
assert.deepEqual([...prompt.tool.inputSchema.properties.skill.enum].sort(), ['other', 'pdf (skills)'])
assert.match(prompt.tool.inputSchema.properties.skill.enum.join(','), /pdf \(skills\)/, 'single load_skill tool replaces per-skill tools')

assert.equal(skills.buildSkillPrompt(scanned.skills, { [byName.get('single').id]: 'off' }).text, '', 'nothing enabled means no system addition')
assert.equal(skills.buildSkillPrompt(scanned.skills, { [byName.get('single').id]: 'off' }).tool, null)

// 预览包含工具定义；提交前的 selection 与 skill.mode 一致。
const preview = skills.renderSkillPreview(scanned.skills, selection)
assert.ok(preview.includes('load_skill') && preview.includes('"enum"'))
assert.deepEqual(skills.selectionOf(scanned.skills), Object.fromEntries(scanned.skills.map((skill) => [skill.id, 'off'])))

// ---- 预算 ----
const big = (name, length) => ({ id: name, name, declaredName: name, description: 'd', body: 'B'.repeat(length), filePath: `/r/${name}/SKILL.md`, root: '/r', disableModelInvocation: false, mode: 'always' })
const budget = skills.buildSkillPrompt([big('one', 8000), big('two', 8000), big('three', 100)], skills.selectionOf([big('one', 0), big('two', 0), big('three', 0)]), 12000)
assert.ok(budget.text.includes('[正文超出常驻预算，已截断]'), 'overflowing body is truncated with a note')
assert.ok(!budget.text.includes('### 常驻技能：three'), 'later skills are dropped once the budget is exhausted')
const bodyChars = budget.text.split('### 常驻技能：').slice(1).reduce((total, section) => total + (section.split('\n').slice(1).join('\n').length), 0)
assert.ok(bodyChars <= 12000, 'inlined bodies stay within the 12000 character budget')
const insideBudget = skills.buildSkillPrompt([big('small', 100)], undefined, 12000)
assert.ok(insideBudget.text.includes('B'.repeat(100)) && !insideBudget.text.includes('已截断'))

// ---- load_skill 参数校验 ----
const ok = skills.loadSkill(scanned.skills, selection, { skill: 'pdf (skills)' })
assert.equal(ok.skill, 'pdf (skills)')
assert.equal(ok.content, 'B 正文')
assert.equal(skills.loadSkill(scanned.skills, selection, { skill: 'single' }).isError, true, 'disabled skills cannot be loaded')
assert.equal(skills.loadSkill(scanned.skills, selection, { skill: 'pdf (pdf-tools)' }).isError, true, 'always skills are not on-demand')
assert.equal(skills.loadSkill(scanned.skills, selection, { skill: 'missing' }).isError, true)
assert.equal(skills.loadSkill(scanned.skills, selection, {}).isError, true)
assert.equal(skills.loadSkill(scanned.skills, selection, { skill: 42 }).isError, true)

// ---- streamAnswer 本地工具 + extraSystem ----
const assistantUrl = await load('../src/assistant.ts', { "from './context'": `from '${contextUrl}'`, "from './skills'": `from '${skillsUrl}'` })
const assistant = await import(assistantUrl)
const streamUrl = await load('../src/stream.ts', { "from './assistant'": `from '${assistantUrl}'`, "from './context'": `from '${contextUrl}'` })
const { streamAnswer } = await import(streamUrl)
const frames = (events) => Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
const toolRound = frames([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'load_skill', arguments: JSON.stringify({ skill: 'pdf (skills)' }) } }] } }] }])
const answerRound = frames([{ choices: [{ delta: { content: '已加载技能。' } }] }])
const bodies = []
const mcpCalls = []
let round = 0
assistant.setPluginContext({ gateway: {
    http: {
        streamOpen: async (_url, options) => { bodies.push(JSON.parse(options.body)); round++; return { streamId: String(round), status: 200 } },
        streamPoll: async () => ({ chunkBase64: (round === 1 ? toolRound : answerRound).toString('base64'), done: true }),
        streamClose: async () => ({ closed: true }),
    },
    mcp: { callTool: async (...args) => { mcpCalls.push(args); return {} } },
} })
const traces = []
const ran = []
const localTools = [{ name: 'load_skill', description: '按名称加载技能', inputSchema: prompt.tool.inputSchema, run: (args) => { ran.push(args); return skills.loadSkill(scanned.skills, selection, args) } }]
const config = { ...assistant.defaultConfig(), apiKey: 'test-key' }
const answer = await streamAnswer(config, 'chat', [{ id: '1', role: 'user', content: '用技能' }], [], () => {}, async () => true, undefined, (trace) => traces.push(trace), { extraSystem: prompt.text, localTools })
assert.equal(answer, '已加载技能。')
assert.ok(bodies[0].messages[0].content.endsWith(`\n\n${prompt.text}`), 'extraSystem is appended after the fixed SYSTEM')
assert.equal(bodies[0].tools.length, 1)
assert.equal(bodies[0].tools[0].function.name, 'load_skill', 'local tool uses its plain name, without an mcp_ prefix')
assert.deepEqual(bodies[0].tools[0].function.parameters, prompt.tool.inputSchema)
assert.deepEqual(ran, [{ skill: 'pdf (skills)' }])
assert.equal(mcpCalls.length, 0, 'local tools never go through gateway.mcp')
assert.equal(traces.at(-1).serverId, 'skill')
assert.equal(traces.at(-1).toolName, 'load_skill')
assert.equal(traces.at(-1).status, 'completed')
assert.ok(traces.at(-1).resultText.includes('B 正文'), 'tool trace shows the loaded body for audit')

// 没有 localTools 时行为不变：system 只有固定文本。
round = 0
const plain = await streamAnswer(config, 'chat', [{ id: '1', role: 'user', content: 'hi' }], [], () => {}, async () => true)
assert.equal(plain, '已加载技能。')
assert.equal(bodies.at(-1).messages[0].content.includes('不是用户'), false)
assert.equal(bodies.at(-1).tools, undefined)

// 本地工具与 MCP 工具重名时报错，且不发出请求。
const before = bodies.length
const clash = await streamAnswer(config, 'chat', [], [{ serverId: 's', name: 'load_skill' }], () => {}, async () => true, undefined, undefined, { localTools }).then(() => '', (error) => String(error?.message ?? error))
assert.match(clash, /重名/)
assert.equal(bodies.length, before)

console.log('AI 助手技能解析、扫描诊断、名称去重、预算截断、模式注入与 load_skill 本地工具回归通过')
