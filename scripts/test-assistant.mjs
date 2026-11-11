import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const contextSource = await readFile(new URL('../src/context.ts', import.meta.url), 'utf8')
const contextCompiled = ts.transpileModule(contextSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const contextUrl = `data:text/javascript;base64,${Buffer.from(contextCompiled).toString('base64')}`
const skillsSource = (await readFile(new URL('../src/skills.ts', import.meta.url), 'utf8')).replace("from './context'", `from '${contextUrl}'`)
const skillsUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(skillsSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`
const source = (await readFile(new URL('../src/assistant.ts', import.meta.url), 'utf8')).replace("from './context'", `from '${contextUrl}'`).replace("from './skills'", `from '${skillsUrl}'`)
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const requests = []
const data = new Map()
api.setPluginContext({
    storage: { get: (key) => data.get(key) ?? null, set: (key, value) => data.set(key, value), delete: (key) => data.delete(key) },
    gateway: {
        http: { postJson: async (url, options) => {
            requests.push({ url, options })
            return { ok: true, status: 200, body: url.endsWith('/messages')
                ? JSON.stringify({ content: [{ type: 'text', text: 'anthropic ok' }] })
                : JSON.stringify({ choices: [{ message: { content: 'openai ok' } }] }) }
        } },
        terminal: { write: async (sessionId, command) => { requests.push({ sessionId, command }) } },
    },
})

const message = [{ id: '1', role: 'user', content: '你好' }]
let config = { ...api.defaultConfig(), apiKey: 'test-key' }
assert.equal(await api.requestAnswer(config, 'chat', message), 'openai ok')
assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions')
assert.equal(requests[0].options.headers.authorization, 'Bearer test-key')
assert.equal(JSON.parse(requests[0].options.body).messages[0].role, 'system')

config = { ...config, provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-test' }
assert.equal(await api.requestAnswer(config, 'chat', message), 'anthropic ok')
assert.equal(requests[1].url, 'https://api.anthropic.com/v1/messages')
assert.equal(requests[1].options.headers['x-api-key'], 'test-key')
assert.equal(requests[1].options.headers['anthropic-version'], '2023-06-01')
assert.equal(JSON.parse(requests[1].options.body).messages[0].role, 'user')

assert.equal(api.redactContext(['token=abc123', 'Bearer abcdefghijklmnop']).includes('abc123'), false)
assert.equal(api.redactContext(['-----BEGIN PRIVATE KEY-----', 'SYNTHETICKEYBODY', '-----END PRIVATE KEY-----']).includes('SYNTHETICKEYBODY'), false)
assert.deepEqual(api.extractCommand('```json\n{"command":"ls -la","explanation":"list"}\n```'), { command: 'ls -la', explanation: 'list' })
assert.equal(api.extractCommand('{"command":"echo ok\\nrm -rf /"}'), null)
assert.equal(api.assessCommand('rm -rf /'), 'critical')
assert.equal(api.assessCommand('dd if=/dev/zero of=/dev/sda'), 'high')
assert.equal(api.assessCommand('sudo apt update'), 'medium')
await api.insertCommand('session-1', 'ls -la')
assert.deepEqual(requests.at(-1), { sessionId: 'session-1', command: 'ls -la' })
await assert.rejects(() => api.insertCommand('session-1', 'ls\r'), /控制字符/)
api.rememberMcpTools('fixture', [{ serverId: 'fixture', name: 'one' }, { serverId: 'fixture', name: 'two' }])
assert.ok(api.getActiveMcpServerIds().includes('fixture'))
api.setEnabledMcpToolIds([api.mcpToolKey({ serverId: 'fixture', name: 'two' })])
assert.deepEqual(api.getEnabledMcpToolIds(), [api.mcpToolKey({ serverId: 'fixture', name: 'two' })])
const traceMessage = { id: 'trace', role: 'assistant', content: 'done', toolCalls: [{ id: 'call', serverId: 'fixture', toolName: 'two', argumentsText: '{}', status: 'completed', callNumber: 1, durationMs: 12, resultText: 'full result' }] }
api.saveHistory('fixture-session', [traceMessage])
assert.deepEqual(api.loadHistory('fixture-session')[0].toolCalls, traceMessage.toolCalls)
api.forgetMcpTools('fixture')
assert.equal(api.getActiveMcpServerIds().includes('fixture'), false)
assert.equal(api.getEnabledMcpToolIds().length, 0)
api.saveSkillSelection({ '/s/skills/a.md': 'always', '/s/skills/b.md': 'off' })
assert.deepEqual(api.loadSkillSelection(), { '/s/skills/a.md': 'always', '/s/skills/b.md': 'off' })
data.delete('config')
assert.equal(api.loadConfig().skillRoots.length, 0, 'old configs without skillRoots load as []')
api.saveConfig({ ...api.defaultConfig(), skillRoots: ['/s/skills'] })
assert.deepEqual(api.loadConfig().skillRoots, ['/s/skills'])
console.log('AI 助手模型格式、上下文脱敏和命令插入回归通过')
