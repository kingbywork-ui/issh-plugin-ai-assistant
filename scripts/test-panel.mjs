import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Compile and interact with the actual plugin panel. All gateway operations and
// storage stay in this browser's memory; no installed plugin or server is used.
const project = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const browser = process.env.ISSH_TEST_BROWSER || [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync)
assert.ok(browser, 'Set ISSH_TEST_BROWSER to a Chromium browser executable')

async function browserFixture (plugin, flushSync, tick) {
    const checks = []
    const target = document.getElementById('fixture')
    const result = document.getElementById('result')
    const storage = new Map()
    const requests = []
    const streamStates = new Map()
    const responses = []
    const connections = []
    const disconnections = []
    const toolAttempts = []
    const executions = []
    const terminalWrites = []
    const listedTools = Array.from({ length: 65 }, (_, index) => ({
        name: `fixture_tool_${String(index + 1).padStart(3, '0')}`,
        description: index === 64 ? 'Late-index searchable tool' : `Fixture description ${index + 1}`,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    }))
    const secrets = ['RECENT_SECRET_987', 'PRIVATE_BODY_ABC123', 'SELECTED_SECRET_987', 'FAILED_SECRET_987', 'FAILED_OUTPUT_SECRET_987', 'LAST_SECRET_987', 'QUESTION_SECRET_987']
    const session = (id = 'fixture-a') => ({
        id, title: id === 'fixture-a' ? 'Fixture A' : 'Fixture B', kind: 'ssh',
        host: 'ops@fixture.invalid', shell: '/bin/bash', cwd: '/srv/fixture',
        lines: ['recent-output-ORIGINAL', 'token=RECENT_SECRET_987', '-----BEGIN OPENSSH PRIVATE KEY-----', 'PRIVATE_BODY_ABC123', '-----END OPENSSH PRIVATE KEY-----'],
        selectedText: 'selected-output-ORIGINAL\npassword=SELECTED_SECRET_987',
        lastFailedCommand: { command: 'curl --token FAILED_SECRET_987 fixture.invalid', exitCode: 7, output: 'failed-output-ORIGINAL\napi_key=FAILED_OUTPUT_SECRET_987' },
        lastCommand: { command: 'printf last-command-ORIGINAL', exitCode: 0, output: ['last-output-ORIGINAL', 'secret=LAST_SECRET_987'] },
    })
    let active = session()
    let panel
    let closePanel
    let pendingConfirmation
    let holdConfirmation = false
    let pendingPoll
    let forbiddenNetwork = 0

    const check = (condition, name) => {
        if (!condition) throw new Error(name)
        checks.push(name)
    }
    const settle = async () => { await tick(); await tick(); flushSync() }
    const waitFor = async (predicate, name, timeout = 4000) => {
        const start = Date.now()
        while (!predicate()) {
            if (Date.now() - start > timeout) throw new Error(`Timeout: ${name}`)
            await new Promise(resolve => setTimeout(resolve, 10))
            await settle()
        }
    }
    const button = text => [...target.querySelectorAll('button')].find(item => item.textContent.trim() === text)
    const click = async text => {
        const element = button(text)
        if (!element) throw new Error(`Missing button: ${text}`)
        if (element.disabled) throw new Error(`Disabled button: ${text}`)
        element.click()
        await settle()
    }
    const field = selector => {
        const element = target.querySelector(selector)
        if (!element) throw new Error(`Missing field: ${selector}`)
        return element
    }
    const edit = async (selector, value) => {
        const element = field(selector)
        element.value = value
        element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
        await settle()
    }
    const summary = text => [...target.querySelectorAll('summary')].find(item => item.textContent.includes(text))
    const toolSection = () => summary('本轮 MCP 工具')?.closest('details')
    const toolChecks = () => [...(toolSection()?.querySelectorAll('input[type="checkbox"]') ?? [])]
    const composer = '.ai-assistant-compose textarea'
    const history = id => JSON.parse(storage.get(`history:${id}`) ?? '[]')
    const hasStop = () => Boolean(button('停止'))
    const prompt = async (text, source = 'recent') => {
        await edit('[aria-label="终端上下文来源"]', source)
        await edit(composer, text)
        await click('预览发送内容')
    }
    const send = async () => { await click('发送预览内容'); await waitFor(() => !hasStop(), 'model turn completion') }
    const encode = value => btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    const abortError = () => new DOMException('Fixture cancelled', 'AbortError')
    const confirm = async () => {
        if (!holdConfirmation) return true
        return new Promise(resolve => { pendingConfirmation = resolve })
    }

    // An accidental direct network path makes the fixture fail instead of using
    // a developer's real endpoint or credentials.
    globalThis.fetch = () => { forbiddenNetwork++; throw new Error('Fixture forbids direct network requests') }
    globalThis.confirm = () => { throw new Error('Use the fake host confirmation') }
    storage.set('config', JSON.stringify({ provider: 'ollama', baseUrl: 'http://fixture.invalid/v1', model: 'fixture-model', apiKey: '', includeTerminalContext: true, mcpServers: [{ id: 'fixture', transport: 'stdio', command: 'not-executed' }] }))
    await plugin.activate({
        storage: { get: key => storage.get(key) ?? null, set: (key, value) => storage.set(key, value), delete: key => storage.delete(key) },
        gateway: {
            ui: { registerPanel: value => { panel = value; return () => {} } },
            log: () => {},
            terminal: { write: async (...args) => { terminalWrites.push(args); return {} } },
            http: {
                postJson: async () => { throw new Error('Unexpected non-streaming model request') },
                streamOpen: async (url, options) => {
                    if (url !== 'http://fixture.invalid/v1/chat/completions') throw new Error(`Unexpected fixture endpoint: ${url}`)
                    const body = JSON.parse(options.body)
                    requests.push(body)
                    const id = `fixture-stream-${requests.length}`
                    streamStates.set(id, { plan: responses.shift() ?? { kind: 'text', text: `Fixture answer ${requests.length}` }, body })
                    return { streamId: id, status: 200 }
                },
                streamPoll: async (id, options) => {
                    const stream = streamStates.get(id)
                    if (!stream) throw new Error(`Unknown fixture stream: ${id}`)
                    let delta
                    if (stream.plan.kind === 'held') {
                        // Deliberately finish after a session switch: the panel
                        // must also guard against a late transport response.
                        const text = await new Promise(resolve => { pendingPoll = resolve })
                        delta = { content: text }
                    } else if (stream.plan.kind === 'tool') {
                        const name = stream.body.tools?.[0]?.function?.name
                        if (!name) throw new Error('Tool scenario received no selected model tool')
                        delta = { tool_calls: [{ index: 0, id: `call-${id}`, function: { name, arguments: JSON.stringify({ path: '/fixture/readme', password: 'ARGUMENT_SECRET_987' }) } }] }
                    } else delta = { content: stream.plan.text }
                    return { chunkBase64: encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`), done: true }
                },
                streamClose: async id => { streamStates.delete(id); return { closed: true } },
            },
            mcp: {
                connect: async id => { connections.push(id); return {} },
                listTools: async () => ({ tools: listedTools }),
                disconnect: async id => { disconnections.push(id); return {} },
                callTool: async (serverId, name, args, options) => {
                    toolAttempts.push({ serverId, name, args })
                    // Represents the host's approval before a real server call.
                    const allowed = await confirm()
                    if (options?.signal?.aborted) throw abortError()
                    if (!allowed) throw new Error('Fixture confirmation rejected')
                    executions.push({ serverId, name, args })
                    return { content: [{ type: 'text', text: `TOOL_FULL_START\n${'x'.repeat(24500)}\nTOOL_FULL_END` }], token: 'RESULT_SECRET_987' }
                },
            },
        },
    })
    const host = { getActiveSession: () => structuredClone(active), confirm }
    const open = async () => { closePanel = panel.mount(target, host); await settle() }
    const close = async () => { closePanel(); await settle(); await waitFor(() => !target.querySelector('.ai-assistant-panel'), 'panel unmount') }

    try {
        await open()
        check(panel.id === 'ai-assistant', 'actual plugin registration and panel mount')
        check(field('[aria-label="终端上下文来源"]').options.length === 4, 'all four terminal context sources are available')
        check([...field('[aria-label="终端上下文来源"]').options].map(option => option.value).join(',') === 'recent,selected,last_failed,last_command', 'context source values match the gateway contract')
        const attachment = [...target.querySelectorAll('label')].find(label => label.textContent.includes('附加终端上下文'))?.querySelector('input[type="checkbox"]')
        check(attachment?.checked, 'attachment checkbox restores saved configuration')

        for (const [source, marker] of [['recent', 'recent-output-ORIGINAL'], ['selected', 'selected-output-ORIGINAL'], ['last_failed', 'failed-output-ORIGINAL'], ['last_command', 'last-output-ORIGINAL']]) {
            if (history('fixture-a').length) await click('新对话')
            active = session()
            await edit('[aria-label="终端上下文来源"]', source)
            await edit(composer, `Question for ${source}; password=QUESTION_SECRET_987`)
            const before = requests.length
            await click('预览发送内容')
            check(requests.length === before && Boolean(button('发送预览内容')), `${source}: first Send opens preview without a model request`)
            const previewText = field('.ai-assistant-preview pre').textContent
            check(previewText.includes(marker), `${source}: preview contains the chosen source`)
            check(!secrets.some(secret => previewText.includes(secret)), `${source}: preview redacts sensitive fields`)
            active.lines = ['recent-output-CHANGED_AFTER_PREVIEW']
            active.selectedText = 'selected-output-CHANGED_AFTER_PREVIEW'
            active.lastFailedCommand.output = 'failed-output-CHANGED_AFTER_PREVIEW'
            active.lastCommand.output = 'last-output-CHANGED_AFTER_PREVIEW'
            if (source === 'recent') {
                await new Promise(resolve => setTimeout(resolve, 1100))
                await settle()
                check(field('.ai-assistant-preview pre').textContent === previewText, 'same-session polling preserves the reviewed preview snapshot')
            }
            await send()
            const serialized = JSON.stringify(requests.at(-1))
            check(requests.length === before + 1 && serialized.includes(marker) && !serialized.includes('CHANGED_AFTER_PREVIEW'), `${source}: request uses the preview snapshot after host output changes`)
            check(requests.at(-1).messages.at(-1).content === previewText, `${source}: transmitted user content exactly matches the displayed preview`)
            check(!secrets.some(secret => serialized.includes(secret)), `${source}: request excludes question, terminal, and private-key secrets`)
            check(serialized.includes('ops@fixture.invalid') && serialized.includes('/bin/bash') && serialized.includes('/srv/fixture'), `${source}: host, shell, and working directory reach the request`)
            check(history('fixture-a').some(message => message.role === 'user' && message.contextText?.includes(marker)), `${source}: selected context snapshot is stored with its user message`)
        }

        await click('新对话')
        active = session()
        await prompt('Refresh the terminal snapshot')
        active.lines = ['recent-output-REFRESHED', 'token=RECENT_SECRET_987']
        await click('刷新预览')
        const refreshed = field('.ai-assistant-preview pre').textContent
        check(refreshed.includes('recent-output-REFRESHED') && !refreshed.includes('recent-output-ORIGINAL'), 'Refresh preview explicitly captures newer host output')
        await send()
        check(requests.at(-1).messages.at(-1).content === refreshed, 'refreshed preview is the exact content sent to the model')

        await click('新对话')
        attachment.checked = false
        attachment.dispatchEvent(new Event('change', { bubbles: true }))
        await settle()
        check(!target.querySelector('[aria-label="终端上下文来源"]') && !JSON.parse(storage.get('config')).includeTerminalContext, 'unchecking attachment removes the source picker and persists the choice')
        await edit(composer, 'Question without terminal attachment')
        await click('预览发送内容')
        check(!field('.ai-assistant-preview pre').textContent.includes('recent-output-REFRESHED'), 'preview excludes terminal content when attachment is disabled')
        await send()
        check(requests.at(-1).messages.at(-1).content === 'Question without terminal attachment', 'disabled attachment sends only the reviewed question')
        attachment.checked = true
        attachment.dispatchEvent(new Event('change', { bubbles: true }))
        await settle()

        await click('新对话')
        active.selectedText = ''
        const beforeMissingContext = requests.length
        await prompt('Missing selected text must not send', 'selected')
        check(!target.querySelector('.ai-assistant-preview') && target.textContent.includes('没有选中文本') && requests.length === beforeMissingContext, 'missing selected context explains the problem and prevents a model request')

        await click('新对话')
        await click('MCP 服务')
        await click('连接')
        await waitFor(() => Boolean(button('断开')), 'fake MCP connection')
        check(connections.length === 1 && target.textContent.includes('65 个工具'), 'MCP connection retains all 65 discovered tools')
        await click('返回对话')
        const section = toolSection()
        check(Boolean(section), 'per-turn MCP tool picker is present')
        if (!section.open) { summary('本轮 MCP 工具').click(); await settle() }
        check(toolChecks().length === 65, 'tool picker contains the 65th tool without silent truncation')
        const beforeLimit = requests.length
        await edit(composer, 'Reject an oversized tool selection')
        await click('预览发送内容')
        if (button('发送预览内容') && !button('发送预览内容').disabled) await click('发送预览内容')
        check(requests.length === beforeLimit && target.textContent.includes('64'), 'more than 64 selected tools shows a limit and sends no request')
        await click('清除选择')
        await edit('input[placeholder="搜索服务、工具或描述"]', 'fixture_tool_065')
        check(toolChecks().length === 1 && toolChecks()[0].closest('label').textContent.includes('fixture · fixture_tool_065'), 'the 65th tool is searchable by its service and name')
        await click('选择搜索结果')
        check(toolChecks()[0].checked, 'search results can enable the 65th tool')
        await edit('input[placeholder="搜索服务、工具或描述"]', 'Late-index')
        check(toolChecks().length === 1 && toolChecks()[0].checked, 'tool description search preserves explicit selection')
        responses.push({ kind: 'tool' }, { kind: 'text', text: 'Tool response complete' })
        await prompt('Read the selected fixture tool')
        const firstToolRequest = requests.length
        await send()
        const definitions = requests[firstToolRequest].tools
        check(definitions.length === 1 && definitions[0].function.name.endsWith('fixture_tool_065'), 'only the explicitly selected 65th tool is sent to the model')
        check(executions.length === 1 && executions[0].name === 'fixture_tool_065', 'model tool call reaches the selected fake MCP tool')
        const card = field('.ai-assistant-tool-call')
        check(card.textContent.includes('fixture_tool_065') && card.textContent.includes('/fixture/readme'), 'tool call card shows tool identity and arguments')
        check(card.querySelector('.ai-assistant-tool-heading span').textContent === '已完成', 'tool call card visibly identifies its completed status')
        check(!card.textContent.includes('ARGUMENT_SECRET_987') && !card.textContent.includes('RESULT_SECRET_987'), 'tool call card redacts arguments and results')
        const fullResult = [...card.querySelectorAll('summary')].find(item => item.textContent.includes('完整结果'))
        check(Boolean(fullResult), 'tool call card exposes an expandable full result')
        fullResult.click()
        await settle()
        check(fullResult.closest('details').open && fullResult.closest('details').textContent.includes('TOOL_FULL_END'), 'expanded result includes content beyond the model follow-up limit')
        const trace = history('fixture-a').flatMap(message => message.toolCalls ?? []).at(-1)
        check(trace?.status === 'completed' && trace.resultText.includes('TOOL_FULL_END') && !trace.resultText.includes('RESULT_SECRET_987'), 'completed call status and full redacted result persist to session history')
        const visualHistory = structuredClone(history('fixture-a'))

        // Both an optional panel approval and the gateway's host confirmation use
        // the same deferred gate. Neither can execute a late approved call after
        // the user has stopped this turn.
        holdConfirmation = true
        responses.push({ kind: 'tool' }, { kind: 'text', text: 'Must not arrive after cancellation' })
        await prompt('Cancel while the host is confirming')
        const executedBeforeCancel = executions.length
        await click('发送预览内容')
        await waitFor(() => Boolean(pendingConfirmation), 'pending tool approval')
        await click('停止')
        pendingConfirmation(true)
        pendingConfirmation = undefined
        holdConfirmation = false
        await waitFor(() => !hasStop(), 'cancelled turn completion')
        responses.length = 0
        check(executions.length === executedBeforeCancel, 'Stop during pending approval prevents the fake MCP server call')
        check(history('fixture-a').flatMap(message => message.toolCalls ?? []).some(item => item.status === 'cancelled'), 'cancelled tool status persists in history')

        await close()
        await open()
        check(disconnections.length === 0 && connections.length === 1, 'closing and reopening the panel keeps the MCP connection without reconnecting')
        await click('MCP 服务')
        check(Boolean(button('断开')) && target.textContent.includes('65 个工具'), 'reopened settings restore the connected server and its complete tool list')
        await click('返回对话')
        if (!toolSection().open) { summary('本轮 MCP 工具').click(); await settle() }
        const restored = toolChecks().filter(input => input.checked)
        check(restored.length === 1 && restored[0].closest('label').textContent.includes('fixture_tool_065'), 'explicit tool selection survives panel remount')
        check(target.querySelectorAll('.ai-assistant-tool-call').length >= 2, 'completed and cancelled tool cards restore from session history')

        await click('新对话')
        responses.push({ kind: 'held' })
        await prompt('Session A pending request')
        await click('发送预览内容')
        await waitFor(() => Boolean(pendingPoll), 'held model stream')
        active = session('fixture-b')
        await waitFor(() => target.querySelector('.ai-assistant-toolbar')?.textContent.includes('Fixture B'), 'switch to session B')
        check(!target.querySelector('.ai-assistant-feed').textContent.includes('Session A pending request'), 'switching sessions clears the previous conversation from the visible feed')
        pendingPoll('Late session A answer')
        pendingPoll = undefined
        await waitFor(() => !hasStop(), 'late stream completion')
        check(history('fixture-b').length === 0 && !target.querySelector('.ai-assistant-feed').textContent.includes('Late session A answer'), 'late session A stream does not pollute session B history or feed')
        active = session()
        await waitFor(() => target.querySelector('.ai-assistant-toolbar')?.textContent.includes('Fixture A'), 'return to session A')
        check(history('fixture-a').some(message => message.content.includes('Session A pending request')), 'the original question remains attached to session A')
        check(forbiddenNetwork === 0 && terminalWrites.length === 0 && disconnections.length === 0, 'fixture uses only fake model/MCP gateways and never writes a terminal or disconnects on close')
        // Leave a useful, entirely synthetic panel state for the optional visual
        // check: a stored completed call plus a reviewed context draft.
        await close()
        storage.set('history:fixture-a', JSON.stringify(visualHistory))
        await open()
        field('.ai-assistant-tool-call summary').click()
        await prompt('分析这次终端上下文与工具调用结果。')
        check(Boolean(target.querySelector('.ai-assistant-tool-call')) && Boolean(target.querySelector('.ai-assistant-preview')), 'final visual fixture displays a restored call card and context preview together')
        result.textContent = JSON.stringify({ passed: checks.length, checks, requests: requests.length, serverCalls: executions.length, confirmationAttempts: toolAttempts.length })
    } catch (error) {
        result.textContent = JSON.stringify({ error: error.message, stack: error.stack, checks })
    }
}

const directory = mkdtempSync(path.join(project, '.tmp-panel-ui-'))
try {
    writeFileSync(path.join(directory, 'index.html'), '<!doctype html><meta charset="UTF-8"><style>:root{--ops-base:#0b0f14;--ops-panel:#121821;--ops-line:#243041;--ops-signal:#59d98e;--ops-signal-dim:rgba(89,217,142,.1);--ops-danger:#ef5f67;--ops-fg:rgba(255,255,255,.9);--ops-fg-muted:rgba(255,255,255,.55);--ops-font-sans:Segoe UI,Microsoft YaHei,sans-serif;--ops-font-mono:Consolas,monospace}body{margin:0;padding:20px;background:var(--ops-base);color:var(--ops-fg);display:flex;justify-content:center}#fixture{width:520px;height:940px;display:flex;background:var(--ops-panel);border:1px solid var(--ops-line)}</style><body><div id="fixture"></div><pre id="result" style="display:none">running</pre><script type="module" src="./fixture.js"></script>')
    writeFileSync(path.join(directory, 'fixture.js'), `import plugin from '../index.ts';\nimport { flushSync, tick } from 'svelte';\n(${browserFixture.toString()})(plugin, flushSync, tick).catch(error => { document.getElementById('result').textContent = JSON.stringify({ error: error.message, stack: error.stack }); });`)
    await build({ root: directory, configFile: false, publicDir: false, base: './', logLevel: 'error', plugins: [svelte()], build: { target: 'es2022', minify: false, outDir: path.join(directory, 'dist'), emptyOutDir: true } })
    const screenshot = process.env.ISSH_PANEL_UI_SCREENSHOT
    const run = spawnSync(browser, ['--headless', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files', '--virtual-time-budget=16000', '--window-size=1200,1000', ...(screenshot ? [`--screenshot=${path.resolve(screenshot)}`] : []), `--user-data-dir=${path.join(directory, 'browser')}`, '--dump-dom', pathToFileURL(path.join(directory, 'dist/index.html')).href], { encoding: 'utf8', timeout: 45000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    assert.equal(run.status, 0, run.error?.message || run.stderr)
    const raw = run.stdout.match(/<pre id="result"[^>]*>([^<]+)<\/pre>/)?.[1]
    assert.ok(raw && raw !== 'running', `Chromium did not finish the assistant panel fixture: ${run.stderr.slice(-1500)}`)
    const result = JSON.parse(raw.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&gt;', '>').replaceAll('&lt;', '<'))
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.ok(result.passed >= 50, JSON.stringify(result))
    if (screenshot) assert.ok(existsSync(screenshot), 'Assistant panel screenshot was not created')
    console.log(`Actual AI assistant panel: ${result.passed} browser interactions passed (${result.requests} fake model requests, ${result.serverCalls} fake MCP execution, ${result.confirmationAttempts} tool attempts)`)
} finally {
    const absolute = path.resolve(directory)
    assert.equal(path.dirname(absolute), project)
    assert.ok(path.basename(absolute).startsWith('.tmp-panel-ui-'))
    rmSync(absolute, { recursive: true, force: true })
}
