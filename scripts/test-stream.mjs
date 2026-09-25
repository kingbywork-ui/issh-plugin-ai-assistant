import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function load (path, replace = {}) {
    let source = await readFile(new URL(path, import.meta.url), 'utf8')
    for (const [before, after] of Object.entries(replace)) source = source.replace(before, after)
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    return { url: `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}` }
}
const assistantModule = await load('../src/assistant.ts')
const assistant = await import(assistantModule.url)
const streamModule = await load('../src/stream.ts', { "from './assistant'": `from '${assistantModule.url}'` })
const { streamAnswer, SseParser } = await import(streamModule.url)

const parser = new SseParser()
assert.deepEqual(parser.push(Buffer.from('data: {"x":"')), [])
assert.deepEqual(parser.push(Buffer.from('好"}\n\n')), [{ event: 'message', data: '{"x":"好"}' }])
const crlf = new SseParser()
assert.deepEqual(crlf.push(Buffer.from('data: ok\r')), [])
assert.deepEqual(crlf.push(Buffer.from('\n\r\n')), [{ event: 'message', data: 'ok' }])
const utf8 = new SseParser()
const unicodeBytes = Buffer.from('data: 你好\n\n')
const splitAt = unicodeBytes.indexOf(Buffer.from('你')) + 1
assert.deepEqual(utf8.push(unicodeBytes.subarray(0, splitAt)), [])
assert.deepEqual(utf8.push(unicodeBytes.subarray(splitAt)), [{ event: 'message', data: '你好' }])

const frames = (events) => Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
const toolRound = frames([
    { choices: [{ delta: { content: '先查询。' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'mcp_0_echo', arguments: '{"text":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] } }] },
])
const answerRound = frames([{ choices: [{ delta: { content: '结果是 hello。' } }] }])
const chunks = [toolRound.subarray(0, 17), toolRound.subarray(17), answerRound]
const bodies = []
const calls = []
const approvals = []
const output = []
let open = 0
let poll = 0
assistant.setPluginContext({ gateway: {
    http: {
        streamOpen: async (_url, options) => { bodies.push(JSON.parse(options.body)); open++; return { streamId: String(open), status: 200 } },
        streamPoll: async () => {
            const index = poll++
            if (index === 0 || index === 1) return { chunkBase64: chunks[index].toString('base64'), done: false }
            if (index === 2) return { chunkBase64: '', done: true }
            if (index === 3) return { chunkBase64: chunks[2].toString('base64'), done: false }
            return { chunkBase64: '', done: true }
        },
        streamClose: async () => ({ closed: true }),
    },
    mcp: { callTool: async (...args) => { calls.push(args); return { content: [{ type: 'text', text: 'hello' }] } } },
} })
const config = { ...assistant.defaultConfig(), apiKey: 'test' }
const result = await streamAnswer(config, 'chat', [{ id: '1', role: 'user', content: '查一下' }],
    [{ serverId: 'local', name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
    (text) => output.push(text), async (tool, args) => { approvals.push({ tool, args }); return true })
assert.equal(result, '先查询。\n结果是 hello。')
assert.equal(bodies[0].stream, true)
assert.equal(bodies[0].tools[0].function.name, 'mcp_0_echo')
assert.equal(bodies[1].messages.at(-1).role, 'tool')
assert.deepEqual(calls[0].slice(0, 3), ['local', 'echo', { text: 'hello' }])
assert.equal(approvals.length, 1)
assert.ok(output.includes('先查询。'))

const anthropicFrames = frames([
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
])
let anthropicPolled = false
assistant.setPluginContext({ gateway: {
    http: {
        streamOpen: async (_url, options) => { assert.equal(JSON.parse(options.body).stream, true); return { streamId: 'anthropic', status: 200 } },
        streamPoll: async () => anthropicPolled ? { chunkBase64: '', done: true } : (anthropicPolled = true, { chunkBase64: anthropicFrames.toString('base64'), done: false }),
        streamClose: async () => ({ closed: true }),
    },
} })
assert.equal(await streamAnswer({ ...config, provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }, 'chat',
    [{ id: '1', role: 'user', content: '你好' }], [], () => {}, async () => true), '你好')
console.log('AI 助手 SSE 分片、OpenAI 工具调用及 Anthropic 流式解析通过')
