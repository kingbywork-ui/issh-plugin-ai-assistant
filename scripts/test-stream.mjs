import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function load (path, replace = {}) {
    let source = await readFile(new URL(path, import.meta.url), 'utf8')
    for (const [before, after] of Object.entries(replace)) source = source.replace(before, after)
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    return { url: `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}` }
}
const contextModule = await load('../src/context.ts')
const assistantModule = await load('../src/assistant.ts', { "from './context'": `from '${contextModule.url}'` })
const assistant = await import(assistantModule.url)
const streamModule = await load('../src/stream.ts', { "from './assistant'": `from '${assistantModule.url}'`, "from './context'": `from '${contextModule.url}'` })
const { streamAnswer, SseParser, MAX_TRACE_CHARACTERS } = await import(streamModule.url)

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
const traces = []
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
    (text) => output.push(text), async (tool, args) => { approvals.push({ tool, args }); return true }, undefined, (trace) => traces.push(trace))
assert.equal(result, '先查询。\n结果是 hello。')
assert.equal(bodies[0].stream, true)
assert.equal(bodies[0].tools[0].function.name, 'mcp_0_echo')
assert.equal(bodies[1].messages.at(-1).role, 'tool')
assert.deepEqual(calls[0].slice(0, 3), ['local', 'echo', { text: 'hello' }])
assert.equal(approvals.length, 1)
assert.ok(output.includes('先查询。'))
assert.equal(traces[0].status, 'pending')
assert.equal(traces.at(-1).status, 'completed')
assert.equal(traces.at(-1).serverId, 'local')
assert.equal(traces.at(-1).toolName, 'echo')
assert.ok(traces.at(-1).resultText.includes('hello'))
assert.ok(traces.at(-1).durationMs >= 0)

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

async function fixture (options = {}) {
    const trace = [], requests = [], actualCalls = []
    let round = 0
    assistant.setPluginContext({ gateway: {
        http: {
            streamOpen: async (_url, request) => { requests.push(JSON.parse(request.body)); round++; return { streamId: String(round), status: 200 } },
            streamPoll: async () => ({ chunkBase64: (options.everyRound ?? (round === 1 ? (options.firstRound ?? toolRound) : answerRound)).toString('base64'), done: true }),
            streamClose: async () => ({ closed: true }),
        },
        mcp: { callTool: async (...args) => {
            if (options.callTool) return options.callTool(actualCalls, ...args)
            actualCalls.push(args)
            return options.result ?? { content: [{ type: 'text', text: 'full result' }] }
        } },
    } })
    const promise = streamAnswer(config, 'fix', [{ id: 'fixture', role: 'user', content: 'test token=fixture-secret' }],
        options.tools ?? [{ serverId: 'local', name: 'echo' }], () => {}, options.approve ?? (async () => true), options.signal, (value) => trace.push(value))
    return { promise, trace, requests, actualCalls }
}

const cancelled = new AbortController()
const afterApproval = await fixture({ signal: cancelled.signal, approve: async () => { cancelled.abort(); return true } })
await assert.rejects(afterApproval.promise, { name: 'AbortError' })
assert.equal(afterApproval.actualCalls.length, 0, 'cancel inside approval must never make an actual tool call')
assert.equal(afterApproval.trace.at(-1).status, 'cancelled')

const pendingHost = new AbortController()
let reachedHostConfirmation
const hostStarted = new Promise((resolve) => { reachedHostConfirmation = resolve })
const awaitingHost = await fixture({ signal: pendingHost.signal, callTool: async (actualCalls, server, name, args, options) => {
    assert.equal(options.signal, pendingHost.signal)
    reachedHostConfirmation()
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('host confirmation cancelled', 'AbortError')), { once: true }))
    actualCalls.push([server, name, args])
} })
await hostStarted
pendingHost.abort()
await assert.rejects(awaitingHost.promise, { name: 'AbortError' })
assert.equal(awaitingHost.actualCalls.length, 0)
assert.equal(awaitingHost.trace.at(-1).status, 'cancelled')

const denied = await fixture({ approve: async () => false })
await denied.promise
assert.equal(denied.actualCalls.length, 0)
assert.equal(denied.trace.at(-1).status, 'denied')
assert.ok(denied.trace.at(-1).resultText.includes('用户拒绝'))

const failure = await fixture({ callTool: async () => { throw new Error('fixture failure token=private-error-token') } })
await failure.promise
assert.equal(failure.trace.at(-1).status, 'error')
assert.ok(failure.trace.at(-1).resultText.includes('fixture failure'))
assert.equal(failure.trace.at(-1).resultText.includes('private-error-token'), false)

const returnedError = await fixture({ result: { isError: true, message: 'tool-side error' } })
await returnedError.promise
assert.equal(returnedError.trace.at(-1).status, 'error')

const oversized = await fixture({ result: { content: [{ text: `token=private-result-token\n${'x'.repeat(MAX_TRACE_CHARACTERS + 2000)}` }] } })
await oversized.promise
assert.equal(oversized.trace.at(-1).truncated, true)
assert.ok(oversized.trace.at(-1).resultText.includes('结果已截断'))
assert.equal(oversized.trace.at(-1).resultText.includes('private-result-token'), false)
assert.ok(oversized.requests[1].messages.at(-1).content.includes('结果已截断'))
assert.equal(JSON.stringify(oversized.requests).includes('fixture-secret'), false)

const excessive = await fixture({ tools: Array.from({ length: 65 }, (_, index) => ({ serverId: 'fixture', name: `tool${index}` })) })
await assert.rejects(excessive.promise, /明确选择最多 64/)
assert.equal(excessive.requests.length, 0)
const lastTool = await fixture({ tools: [{ serverId: 'fixture', name: 'tool64' }], firstRound: answerRound })
await lastTool.promise
assert.equal(lastTool.requests[0].tools[0].function.name, 'mcp_0_tool64')

const budget = await fixture({ firstRound: frames([{ choices: [{ delta: { tool_calls: Array.from({ length: 9 }, (_, index) => ({ index, id: `call-${index}`, function: { name: 'mcp_0_echo', arguments: '{}' } })) } }] }]) })
await assert.rejects(budget.promise, /预算已用尽/)
assert.equal(budget.actualCalls.length, 0)
const roundBudget = await fixture({ everyRound: toolRound })
await assert.rejects(roundBudget.promise, /5 个模型回合/)
assert.equal(roundBudget.requests.length, 5)
assert.equal(roundBudget.actualCalls.length, 4, 'the fifth model round must not start another tool call')
console.log('AI 调用记录、拒绝/错误/取消、宿主确认取消、结果脱敏与显式工具/调用预算回归通过')
