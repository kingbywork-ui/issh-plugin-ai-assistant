<script lang="ts">
    import { onMount } from 'svelte'
    import type { PanelHostContext } from './plugin-api'
    import panelCss from './assistant.css?inline'
    import {
        PROVIDERS, assessCommand, clearHistory, extractCommand, insertCommand,
        loadConfig, loadHistory, pluginContext, redactContext, saveConfig, saveHistory,
        type AssistantMode, type Message, type McpServerConfig,
    } from './assistant'
    import { streamAnswer, type McpTool } from './stream'

    let { host }: { host: PanelHostContext } = $props()
    let config = $state(loadConfig())
    let sessionKey = $state('global')
    let sessionTitle = $state('无活动终端')
    let messages = $state<Message[]>([])
    let input = $state('')
    let mode = $state<AssistantMode>('chat')
    let busy = $state(false)
    let error = $state('')
    let settingsOpen = $state(false)
    let feed: HTMLDivElement | null = $state(null)
    let tools = $state<McpTool[]>([])
    let connected = $state<string[]>([])
    let mcpId = $state('local')
    let mcpCommand = $state('')
    let mcpArguments = $state('[]')
    let mcpCwd = $state('')
    let mcpEnvironment = $state('{}')
    let controller: AbortController | null = null

    onMount(() => {
        document.getElementById('issh-ai-assistant-style')?.remove()
        const style = document.createElement('style')
        style.id = 'issh-ai-assistant-style'
        style.textContent = panelCss
        document.head.appendChild(style)
        syncSession()
        const timer = setInterval(syncSession, 1000)
        return () => {
            clearInterval(timer); style.remove(); controller?.abort()
            for (const serverId of connected) void pluginContext().gateway.mcp.disconnect(serverId).catch(() => undefined)
        }
    })

    function syncSession (): void {
        const active = host.getActiveSession()
        const nextKey = active?.id ?? 'global'
        sessionTitle = active?.title ?? '无活动终端'
        if (nextKey === sessionKey) return
        sessionKey = nextKey
        messages = loadHistory(nextKey)
        error = ''
    }

    function persist (): void { saveConfig(config) }

    function switchProvider (): void {
        const defaults = PROVIDERS[config.provider]
        config.baseUrl = defaults.baseUrl
        config.model = defaults.model
        config.apiKey = ''
        persist()
    }

    function scrollFeed (): void {
        requestAnimationFrame(() => { if (feed) feed.scrollTop = feed.scrollHeight })
    }

    async function connectMcp (server: McpServerConfig): Promise<void> {
        try {
            await pluginContext().gateway.mcp.connect(server.id, {
                command: server.command, arguments: server.arguments, cwd: server.cwd, environment: server.environment,
            }, { timeoutMs: 35000 })
            const listed = await pluginContext().gateway.mcp.listTools(server.id, { timeoutMs: 35000 })
            tools = [...tools.filter((tool) => tool.serverId !== server.id), ...listed.tools.map((tool) => ({ ...tool, serverId: server.id }))]
            connected = [...connected, server.id]
            error = ''
        } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
        if (!connected.includes(server.id)) await pluginContext().gateway.mcp.disconnect(server.id).catch(() => undefined)
    }

    async function disconnectMcp (serverId: string): Promise<void> {
        try { await pluginContext().gateway.mcp.disconnect(serverId) }
        catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
        connected = connected.filter((id) => id !== serverId)
        tools = tools.filter((tool) => tool.serverId !== serverId)
    }

    function addMcpServer (): void {
        const id = mcpId.trim()
        const command = mcpCommand.trim()
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !command) { error = '请填写有效的 MCP 服务 ID 和可执行命令'; return }
        if (config.mcpServers.some((server) => server.id === id)) { error = 'MCP 服务 ID 已存在'; return }
        let environment: Record<string, string>
        let arguments_: string[]
        try {
            environment = JSON.parse(mcpEnvironment) as Record<string, string>
            if (!environment || Array.isArray(environment) || typeof environment !== 'object' || Object.values(environment).some((value) => typeof value !== 'string')) throw new Error()
        } catch { error = '环境变量须为 JSON 字符串对象'; return }
        try {
            arguments_ = JSON.parse(mcpArguments) as string[]
            if (!Array.isArray(arguments_) || arguments_.some((value) => typeof value !== 'string')) throw new Error()
        } catch { error = '参数须为 JSON 字符串数组'; return }
        config.mcpServers = [...config.mcpServers, { id, command, arguments: arguments_, cwd: mcpCwd.trim() || undefined, environment }]
        persist()
        mcpCommand = ''; mcpArguments = '[]'; mcpCwd = ''; mcpEnvironment = '{}'; error = ''
    }

    async function removeMcpServer (id: string): Promise<void> {
        if (connected.includes(id)) await disconnectMcp(id)
        config.mcpServers = config.mcpServers.filter((server) => server.id !== id)
        persist()
    }

    async function submit (): Promise<void> {
        const question = input.trim()
        if (!question || busy) return
        if (!config.baseUrl.trim() || !config.model.trim() || (!config.apiKey.trim() && !['ollama', 'vllm'].includes(config.provider))) {
            settingsOpen = true
            error = '请先配置 API 地址、模型和所需的 API Key'
            return
        }
        const active = host.getActiveSession()
        const conversationKey = sessionKey
        const user: Message = { id: crypto.randomUUID(), role: 'user', content: question }
        const prior = messages
        messages = [...prior, user]
        saveHistory(conversationKey, messages)
        input = ''
        busy = true
        error = ''
        controller = new AbortController()
        const response: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', sessionId: active?.id }
        messages = [...messages, response]
        scrollFeed()
        try {
            const contextText = config.includeTerminalContext && active?.lines.length
                ? `\n\n当前终端（${active.title}，${active.kind}）最近输出，仅供分析：\n${redactContext(active.lines)}`
                : ''
            const requestMessages = [...prior, { ...user, content: question + contextText }]
            const answer = await streamAnswer(config, mode, requestMessages, tools, (text) => {
                response.content = text
                if (sessionKey === conversationKey) {
                    messages = messages.map((item) => item.id === response.id ? { ...response } : item)
                    scrollFeed()
                }
            }, async () => true, controller.signal)
            const parsed = mode === 'command' || mode === 'fix' ? extractCommand(answer) : null
            response.content = parsed ? (parsed.explanation || '已生成命令，请检查后再插入终端。') : answer
            response.command = parsed?.command
            if (sessionKey === conversationKey) {
                messages = messages.map((item) => item.id === response.id ? { ...response } : item)
                saveHistory(conversationKey, messages)
                scrollFeed()
            } else {
                saveHistory(conversationKey, [...loadHistory(conversationKey), response])
            }
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
            messages = messages.filter((item) => item.id !== response.id || Boolean(item.content))
        } finally {
            busy = false
            controller = null
        }
    }

    async function insert (message: Message): Promise<void> {
        if (!message.command) return
        const current = host.getActiveSession()
        if (!current || current.id !== message.sessionId) { error = '请切回生成命令时的终端标签'; return }
        const risk = assessCommand(message.command)
        if (risk === 'critical') { error = '此命令风险极高，AI 助手不会将它写入终端'; return }
        if (risk !== 'low' && !window.confirm(`命令风险：${risk === 'high' ? '高' : '中'}。确认插入到 ${current.title}？\n\n${message.command}`)) return
        try {
            await insertCommand(current.id, message.command)
            error = ''
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    function newConversation (): void {
        clearHistory(sessionKey)
        messages = []
        error = ''
    }

    function onInputKey (event: KeyboardEvent): void {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            void submit()
        }
    }
</script>

<div class="ai-assistant-panel">
    <div class="ai-assistant-toolbar">
        <span title={sessionTitle}>终端：{sessionTitle}</span>
        <button type="button" disabled={busy} onclick={newConversation} title="清空当前会话">新对话</button>
        {#if busy}<button type="button" onclick={() => controller?.abort()}>停止</button>{/if}
        <button type="button" onclick={() => { settingsOpen = !settingsOpen }} aria-expanded={settingsOpen}>配置</button>
    </div>
    {#if settingsOpen}
        <div class="ai-assistant-settings">
            <label>服务商
                <select bind:value={config.provider} onchange={switchProvider}>
                    {#each Object.entries(PROVIDERS) as [value, provider]}
                        <option value={value}>{provider.label}</option>
                    {/each}
                </select>
            </label>
            <label>API 地址<input type="url" bind:value={config.baseUrl} onchange={persist} placeholder="https://api.openai.com/v1" /></label>
            <label>模型<input type="text" bind:value={config.model} onchange={persist} placeholder="模型名称" /></label>
            <label>API Key<input type="password" bind:value={config.apiKey} onchange={persist} autocomplete="off" placeholder="本地模型可留空" /></label>
            <label class="ai-assistant-check"><input type="checkbox" bind:checked={config.includeTerminalContext} onchange={persist} />发送最近终端输出（脱敏后）</label>
            <div class="ai-assistant-mcp">
                <strong>本地 MCP 服务</strong>
                {#each config.mcpServers as server (server.id)}
                    <div class="ai-assistant-mcp-row">
                        <span>{server.id} · {connected.includes(server.id) ? `${tools.filter((tool) => tool.serverId === server.id).length} 个工具` : '未连接'}</span>
                        {#if connected.includes(server.id)}
                            <button type="button" onclick={() => void disconnectMcp(server.id)}>断开</button>
                        {:else}
                            <button type="button" onclick={() => void connectMcp(server)}>连接</button>
                        {/if}
                        <button type="button" onclick={() => void removeMcpServer(server.id)}>删除</button>
                    </div>
                {/each}
                <label>服务 ID<input bind:value={mcpId} placeholder="local" /></label>
                <label>可执行命令<input bind:value={mcpCommand} placeholder="node 或本地 MCP 服务程序路径" /></label>
                <label>参数 JSON 数组<input bind:value={mcpArguments} placeholder={'["server.mjs"]'} /></label>
                <label>工作目录（可选）<input bind:value={mcpCwd} /></label>
                <label>环境变量 JSON<input bind:value={mcpEnvironment} placeholder={'{"KEY":"value"}'} /></label>
                <button type="button" onclick={addMcpServer}>添加服务</button>
            </div>
        </div>
    {/if}
    <div class="ai-assistant-feed" bind:this={feed} role="log" aria-live="polite">
        {#if messages.length === 0}
            <div class="ai-assistant-empty">询问终端问题，或选择命令生成、解释与错误分析。命令只会插入终端，不会自动执行。</div>
        {/if}
        {#each messages as message (message.id)}
            <div class="ai-assistant-message" class:user={message.role === 'user'}>
                <span class="ai-assistant-role">{message.role === 'user' ? '你' : 'AI 助手'}</span>
                <div class="ai-assistant-text">{message.content}</div>
                {#if message.command}
                    <div class="ai-assistant-command"><code>{message.command}</code><span>风险：{assessCommand(message.command)}</span></div>
                    <button type="button" disabled={assessCommand(message.command) === 'critical'} onclick={() => void insert(message)}>插入当前终端</button>
                {/if}
            </div>
        {/each}
        {#if busy}<div class="ai-assistant-wait" role="status">正在接收模型响应…</div>{/if}
    </div>
    {#if error}<div class="ai-assistant-error" role="alert">{error}</div>{/if}
    <div class="ai-assistant-compose">
        <select bind:value={mode} aria-label="操作模式">
            <option value="chat">对话</option>
            <option value="command">生成命令</option>
            <option value="explain">解释命令</option>
            <option value="fix">分析错误</option>
        </select>
        <textarea bind:value={input} onkeydown={onInputKey} placeholder="输入问题或命令；Ctrl+Enter 发送" rows="3"></textarea>
        <button type="button" disabled={busy || !input.trim()} onclick={() => void submit()}>发送</button>
    </div>
</div>
