<script lang="ts">
    import { onMount } from 'svelte'
    import type { PanelHostContext } from './plugin-api'
    import panelCss from './assistant.css?inline'
    import {
        PROVIDERS, assessCommand, clearHistory, extractCommand, insertCommand,
        forgetMcpTools, getActiveMcpServerIds, getActiveMcpTools, getEnabledMcpToolIds, loadConfig, loadHistory, loadSkillSelection, MAX_MCP_TOOLS, mcpToolKey, pluginContext, rememberMcpTools, saveConfig, saveHistory, saveSkillSelection, setEnabledMcpToolIds,
        type AssistantMode, type Message, type McpServerConfig, type McpTransport, type ToolCallTrace,
    } from './assistant'
    import { buildTerminalContext, CONTEXT_SOURCES, redactText, type TerminalContextSource } from './context'
    import { MAX_MODEL_ROUNDS, MAX_TOOL_CALLS, streamAnswer, type LocalTool, type McpTool } from './stream'
    import {
        buildSkillPrompt, loadSkill, MAX_SKILL_ROOTS, renderSkillPreview, scanSkills, selectionOf, SKILL_DEFAULT_ROOT, SKILL_MODES, skillFs,
        type Skill, type SkillDiagnostic, type SkillMode,
    } from './skills'

    type SettingsPage = 'chat' | 'model' | 'mcp' | 'skills'
    let { host }: { host: PanelHostContext } = $props()
    let config = $state(loadConfig())
    let sessionKey = $state('')
    let sessionTitle = $state('无活动终端')
    let messages = $state<Message[]>([])
    let input = $state('')
    let mode = $state<AssistantMode>('chat')
    let busy = $state(false)
    let error = $state('')
    let settingsPage = $state<SettingsPage>('chat')
    let feed: HTMLDivElement | null = $state(null)
    let tools = $state<McpTool[]>(getActiveMcpTools())
    let connected = $state<string[]>(getActiveMcpServerIds())
    let enabledToolIds = $state<string[]>(getEnabledMcpToolIds())
    let toolSearch = $state('')
    let mcpPending = $state<string[]>([])
    let skills = $state<Skill[]>([])
    let skillDiagnostics = $state<SkillDiagnostic[]>([])
    let skillScanning = $state(false)
    let skillRootInput = $state('')
    let skillScanSummary = $state('')
    let contextSource = $state<TerminalContextSource>('recent')
    let recentLines = $state(100)
    // skillText 为本轮注入 system 的技能部分（预览用）；技能只影响 system，不改变发送的对话内容。
    let preview = $state<{ fingerprint: string; text: string; contextText: string; skillText: string; warning?: string; sessionId?: string } | null>(null)
    const enabledTools = $derived(tools.filter((tool) => enabledToolIds.includes(mcpToolKey(tool))))
    const filteredTools = $derived(tools.filter((tool) => `${tool.serverId} ${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(toolSearch.trim().toLowerCase())))
    const skillSelection = $derived(selectionOf(skills))
    const skillPrompt = $derived(buildSkillPrompt(skills, skillSelection))
    // 技能模式与根目录都会改变 system 注入，因此一并计入指纹，变化后需刷新预览。
    const draftFingerprint = $derived(JSON.stringify([input.trim(), mode, sessionKey, config.includeTerminalContext, contextSource, recentLines, enabledToolIds, config.provider, config.baseUrl, config.model, config.apiKey, config.skillRoots, skillPrompt.text, skillPrompt.tool]))
    const previewIsCurrent = $derived(Boolean(preview && preview.fingerprint === draftFingerprint))
    let mcpId = $state('local')
    let mcpCommand = $state('')
    let mcpArguments = $state('[]')
    let mcpCwd = $state('')
    let mcpEnvironment = $state('{}')
    let mcpTransport = $state<McpTransport>('stdio')
    let mcpUrl = $state('')
    let mcpHeaders = $state('{}')
    let controller: AbortController | null = null

    onMount(() => {
        document.getElementById('issh-ai-assistant-style')?.remove()
        const style = document.createElement('style')
        style.id = 'issh-ai-assistant-style'
        style.textContent = panelCss
        document.head.appendChild(style)
        syncSession()
        const timer = setInterval(syncSession, 1000)
        // 启动时按已保存的根目录静默扫描，恢复技能列表与各技能模式。
        if (config.skillRoots.length) void rescanSkills()
        return () => {
            clearInterval(timer); style.remove(); controller?.abort()
        }
    })

    function syncSession (): void {
        const active = host.getActiveSession()
        const nextKey = active?.id ?? 'global'
        sessionTitle = active?.title ?? '无活动终端'
        tools = getActiveMcpTools()
        connected = getActiveMcpServerIds()
        enabledToolIds = getEnabledMcpToolIds()
        if (nextKey === sessionKey) return
        sessionKey = nextKey
        messages = loadHistory(nextKey)
        preview = null
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
        if (mcpPending.includes(server.id)) return
        mcpPending = [...mcpPending, server.id]
        try {
            await pluginContext().gateway.mcp.connect(server.id, {
                transport: server.transport ?? 'stdio', command: server.command, arguments: server.arguments,
                cwd: server.cwd, environment: server.environment, url: server.url, headers: server.headers,
            }, { timeoutMs: 35000 })
            const listed = await pluginContext().gateway.mcp.listTools(server.id, { timeoutMs: 35000 })
            const serverTools = listed.tools.map((tool) => ({ ...tool, serverId: server.id }))
            rememberMcpTools(server.id, serverTools)
            tools = [...tools.filter((tool) => tool.serverId !== server.id), ...serverTools]
            connected = [...new Set([...connected, server.id])]
            enabledToolIds = getEnabledMcpToolIds()
            error = ''
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
            if (!connected.includes(server.id)) await pluginContext().gateway.mcp.disconnect(server.id).catch(() => undefined)
        } finally {
            mcpPending = mcpPending.filter((id) => id !== server.id)
        }
    }

    async function disconnectMcp (serverId: string): Promise<void> {
        if (busy || mcpPending.includes(serverId)) return
        try { await pluginContext().gateway.mcp.disconnect(serverId) }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
            return
        }
        forgetMcpTools(serverId)
        connected = connected.filter((id) => id !== serverId)
        tools = tools.filter((tool) => tool.serverId !== serverId)
        enabledToolIds = getEnabledMcpToolIds()
    }

    function addMcpServer (): void {
        const id = mcpId.trim()
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) { error = '服务 ID 只能使用字母、数字、下划线和连字符，最长 64 位'; return }
        if (config.mcpServers.some((server) => server.id === id)) { error = 'MCP 服务 ID 已存在'; return }
        let server: McpServerConfig
        if (mcpTransport === 'stdio') {
            const command = mcpCommand.trim()
            if (!command) { error = '请填写可执行命令'; return }
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
            server = { id, transport: 'stdio', command, arguments: arguments_, cwd: mcpCwd.trim() || undefined, environment }
        } else {
            const url = mcpUrl.trim()
            try {
                const parsed = new URL(url)
                if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error()
                if (parsed.username || parsed.password || parsed.hash) throw new Error()
            } catch { error = '远程服务请填写 HTTPS 地址；本机可用 HTTP'; return }
            let headers: Record<string, string>
            try {
                headers = JSON.parse(mcpHeaders) as Record<string, string>
                if (!headers || Array.isArray(headers) || typeof headers !== 'object' || Object.values(headers).some((value) => typeof value !== 'string')) throw new Error()
            } catch { error = '请求头须为 JSON 字符串对象'; return }
            server = { id, transport: mcpTransport, url, headers }
        }
        config.mcpServers = [...config.mcpServers, server]
        persist()
        mcpId = ''; mcpCommand = ''; mcpArguments = '[]'; mcpCwd = ''; mcpEnvironment = '{}'; mcpUrl = ''; mcpHeaders = '{}'; error = ''
    }

    async function removeMcpServer (id: string): Promise<void> {
        if (busy || mcpPending.includes(id)) return
        if (connected.includes(id)) await disconnectMcp(id)
        if (connected.includes(id)) return
        config.mcpServers = config.mcpServers.filter((server) => server.id !== id)
        persist()
    }

    function toggleTool (tool: McpTool, enabled: boolean): void {
        const id = mcpToolKey(tool)
        if (enabled && !enabledToolIds.includes(id) && enabledToolIds.length >= MAX_MCP_TOOLS) { error = `本轮最多启用 ${MAX_MCP_TOOLS} 个工具，请先取消其他工具`; return }
        enabledToolIds = enabled ? [...new Set([...enabledToolIds, id])] : enabledToolIds.filter((item) => item !== id)
        setEnabledMcpToolIds(enabledToolIds)
        error = ''
    }

    function selectFilteredTools (): void {
        const ids = [...new Set([...enabledToolIds, ...filteredTools.map(mcpToolKey)])]
        if (ids.length > MAX_MCP_TOOLS) { error = `选择后共 ${ids.length} 个工具，超过 ${MAX_MCP_TOOLS} 个上限；请缩小搜索或逐项选择`; return }
        enabledToolIds = ids
        setEnabledMcpToolIds(ids)
        error = ''
    }

    function clearToolSelection (): void {
        enabledToolIds = []
        setEnabledMcpToolIds([])
        error = ''
    }

    /** 按当前根目录重新扫描；扫描期间根目录变化则丢弃结果。report 为 true 时把失败显示在错误栏。 */
    async function rescanSkills (report = false): Promise<void> {
        if (skillScanning) return
        const roots = [...config.skillRoots]
        if (!roots.length) { skills = []; skillDiagnostics = []; skillScanSummary = report ? '请先添加技能根目录' : ''; return }
        skillScanning = true
        try {
            const result = await scanSkills(roots, { fs: skillFs(pluginContext()), modes: loadSkillSelection() })
            if (JSON.stringify(roots) !== JSON.stringify(config.skillRoots)) return
            skills = result.skills
            skillDiagnostics = result.diagnostics
            skillScanSummary = `已找到 ${result.skills.length} 个技能${result.diagnostics.length ? `，${result.diagnostics.length} 条诊断` : ''}`
            if (report) error = ''
        } catch (cause) {
            if (report) error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            skillScanning = false
        }
    }

    function addSkillRoot (): void {
        const root = skillRootInput.trim()
        if (!root) { error = '请填写技能根目录路径'; return }
        const normalize = (value: string): string => value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        if (config.skillRoots.some((item) => normalize(item) === normalize(root))) { error = '该技能根目录已存在'; return }
        if (config.skillRoots.length >= MAX_SKILL_ROOTS) { error = `最多 ${MAX_SKILL_ROOTS} 个技能根目录`; return }
        config.skillRoots = [...config.skillRoots, root]
        skillRootInput = ''
        persist()
        void rescanSkills(true)
    }

    function removeSkillRoot (root: string): void {
        config.skillRoots = config.skillRoots.filter((item) => item !== root)
        persist()
        void rescanSkills()
    }

    function setSkillMode (skill: Skill, value: SkillMode): void {
        skills = skills.map((item) => item.id === skill.id ? { ...item, mode: value } : item)
        saveSkillSelection(selectionOf(skills))
        error = ''
    }

    function preparePreview (): void {
        if (!input.trim() || busy) return
        syncSession()
        if (enabledTools.length > MAX_MCP_TOOLS) { error = `本轮已启用 ${enabledTools.length} 个 MCP 工具，请明确选择最多 ${MAX_MCP_TOOLS} 个工具`; return }
        const active = host.getActiveSession()
        const context = config.includeTerminalContext ? buildTerminalContext(active, contextSource, { recentLines }) : null
        if (context && !context.available) { preview = null; error = context.warning ?? '所选上下文不可用'; return }
        const contextText = context?.text ?? ''
        preview = {
            fingerprint: draftFingerprint, text: redactText(input.trim()) + (contextText ? `\n\n${contextText}` : ''),
            contextText, skillText: renderSkillPreview(skills, skillSelection), warning: context?.warning, sessionId: active?.id,
        }
        error = ''
    }

    async function submit (): Promise<void> {
        const question = input.trim()
        if (!question || busy) return
        if (host.getActiveSession()?.id !== (sessionKey === 'global' ? undefined : sessionKey)) { syncSession(); preparePreview(); return }
        if (!previewIsCurrent || !preview) { preparePreview(); return }
        if (!config.baseUrl.trim() || !config.model.trim() || (!config.apiKey.trim() && !['ollama', 'vllm'].includes(config.provider))) {
            settingsPage = 'model'
            error = '请先配置 API 地址、模型和所需的 API Key'
            return
        }
        const conversationKey = sessionKey
        const snapshot = preview
        const requestMode = mode
        const requestConfig = { ...config }
        const requestTools = [...enabledTools]
        // 提交时对技能拍快照：本轮 system 注入与 load_skill 使用同一份数据。
        const requestSkills = skills.map((skill) => ({ ...skill }))
        const requestModes = selectionOf(requestSkills)
        const requestSkillPrompt = buildSkillPrompt(requestSkills, requestModes)
        const localTools: LocalTool[] = requestSkillPrompt.tool
            ? [{ name: requestSkillPrompt.tool.name, description: requestSkillPrompt.tool.description, inputSchema: requestSkillPrompt.tool.inputSchema, run: (args) => loadSkill(requestSkills, requestModes, args) }]
            : []
        const user: Message = { id: crypto.randomUUID(), role: 'user', content: redactText(question), contextText: snapshot.contextText || undefined }
        const prior = messages
        messages = [...prior, user]
        saveHistory(conversationKey, messages)
        input = ''
        preview = null
        busy = true
        error = ''
        controller = new AbortController()
        const response: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', sessionId: snapshot.sessionId, toolCalls: [] }
        messages = [...messages, response]
        scrollFeed()
        const updateResponse = (persistHistory = false): void => {
            const history = [...prior, user, { ...response, toolCalls: [...(response.toolCalls ?? [])] }]
            if (sessionKey === conversationKey) { messages = history; scrollFeed() }
            if (persistHistory) saveHistory(conversationKey, history)
        }
        try {
            const requestMessages = [...prior, { ...user, content: snapshot.text }]
            const answer = await streamAnswer(requestConfig, requestMode, requestMessages, requestTools, (text) => {
                response.content = text
                updateResponse()
            }, async () => true, controller.signal, (trace) => {
                response.toolCalls = [...(response.toolCalls ?? []).filter((item) => item.id !== trace.id), trace]
                updateResponse(true)
            }, { extraSystem: requestSkillPrompt.text || undefined, localTools })
            const parsed = requestMode === 'command' || requestMode === 'fix' ? extractCommand(answer) : null
            response.content = parsed ? (parsed.explanation || '已生成命令，请检查后再插入终端。') : answer
            response.command = parsed?.command
            updateResponse(true)
        } catch (cause) {
            const stopped = controller?.signal.aborted || (cause instanceof Error && cause.name === 'AbortError')
            const failure = stopped ? '本轮请求已停止。' : redactText(cause instanceof Error ? cause.message : String(cause))
            response.content ||= failure
            if (sessionKey === conversationKey) error = stopped ? '' : failure
            updateResponse(true)
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
        if (risk !== 'low') {
            if (!host.confirm) { error = '当前宿主未提供命令确认弹窗，请更新 issh 后重试'; return }
            if (!await host.confirm(`命令风险：${risk === 'high' ? '高' : '中'}。确认插入到 ${current.title}？\n\n${message.command}`, 'AI 命令确认')) return
            if (host.getActiveSession()?.id !== current.id) { error = '请切回生成命令时的终端标签'; return }
        }
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
        preview = null
    }

    function traceStatus (trace: ToolCallTrace): string {
        return { pending: '等待宿主确认 / 执行中', completed: '已完成', error: '错误', denied: '已拒绝', cancelled: '已停止' }[trace.status]
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
        <button type="button" class:active={settingsPage === 'model'} onclick={() => { settingsPage = settingsPage === 'model' ? 'chat' : 'model'; error = '' }} aria-pressed={settingsPage === 'model'}>模型供应商</button>
        <button type="button" class:active={settingsPage === 'mcp'} onclick={() => { settingsPage = settingsPage === 'mcp' ? 'chat' : 'mcp'; error = '' }} aria-pressed={settingsPage === 'mcp'}>MCP 服务</button>
        <button type="button" class:active={settingsPage === 'skills'} onclick={() => { settingsPage = settingsPage === 'skills' ? 'chat' : 'skills'; error = '' }} aria-pressed={settingsPage === 'skills'}>技能</button>
    </div>
    {#if settingsPage !== 'chat'}
        <div class="ai-assistant-settings">
            {#if settingsPage === 'model'}
            <div class="ai-assistant-settings-heading"><h2>模型供应商</h2><button type="button" onclick={() => { settingsPage = 'chat'; error = '' }}>返回对话</button></div>
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
            {:else if settingsPage === 'skills'}
            <div class="ai-assistant-skills">
                <div class="ai-assistant-settings-heading"><h2>技能</h2><button type="button" onclick={() => { settingsPage = 'chat'; error = '' }}>返回对话</button></div>
                <p class="ai-assistant-help">读取指定目录中的 Agent Skills 文件（单个 .md 文件，或 &lt;目录&gt;/SKILL.md，需含 name、description frontmatter）。常驻：正文拼入 system；按需：只提供名称和描述，模型经 load_skill 工具加载正文；不启用：完全不出现。</p>
                <h3>技能根目录</h3>
                {#each config.skillRoots as root (root)}
                    <div class="ai-assistant-mcp-row">
                        <span><strong>{root}</strong></span>
                        <button type="button" disabled={skillScanning} onclick={() => removeSkillRoot(root)}>删除</button>
                    </div>
                {/each}
                <label>新增根目录<input type="text" bind:value={skillRootInput} onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addSkillRoot() } }} placeholder="例如 ~/.claude/skills 或 D:\skills" />（路径须为绝对路径）</label>
                <div class="ai-assistant-tool-actions">
                    <button type="button" disabled={skillScanning} onclick={() => { skillRootInput = SKILL_DEFAULT_ROOT; addSkillRoot() }}>使用默认目录</button>
                    <button type="button" disabled={skillScanning} onclick={addSkillRoot}>添加并扫描</button>
                    <button type="button" disabled={skillScanning || !config.skillRoots.length} onclick={() => void rescanSkills()}>{skillScanning ? '扫描中…' : '重新扫描'}</button>
                </div>
                {#if skillScanSummary}<p class="ai-assistant-help">{skillScanSummary}</p>{/if}
                {#if skillDiagnostics.length}
                    <details class="ai-assistant-skill-diagnostics" open>
                        <summary>扫描诊断（{skillDiagnostics.length}）</summary>
                        <ul class="ai-assistant-skill-list">
                            {#each skillDiagnostics as diagnostic}<li><strong>{diagnostic.filePath || '全部目录'}</strong><small>{diagnostic.message}</small></li>{/each}
                        </ul>
                    </details>
                {/if}
                <h3>已发现的技能（{skills.length}）</h3>
                {#if skills.length === 0}
                    <p class="ai-assistant-help">{config.skillRoots.length ? '没有找到有效技能。' : '添加技能根目录后点击扫描。'}</p>
                {/if}
                {#each skills as skill (skill.id)}
                    <div class="ai-assistant-skill-row">
                        <div class="ai-assistant-skill-meta">
                            <strong>{skill.name}</strong>
                            <small>{skill.description}</small>
                            <small class="ai-assistant-skill-source" title={skill.filePath}>{skill.filePath}</small>
                            {#if skill.disableModelInvocation}<small>已声明 disable-model-invocation</small>{/if}
                        </div>
                        <div class="ai-assistant-skill-modes" role="radiogroup" aria-label="{skill.name} 启用模式">
                            {#each Object.entries(SKILL_MODES) as [value, label]}
                                <label class="ai-assistant-skill-mode"><input type="radio" name="skill-mode-{skill.id}" value={value} checked={skill.mode === value} onchange={() => setSkillMode(skill, value as SkillMode)} />{label}</label>
                            {/each}
                        </div>
                    </div>
                {/each}
            </div>
            {:else}
            <div class="ai-assistant-mcp">
                <div class="ai-assistant-settings-heading"><h2>MCP 服务</h2><button type="button" onclick={() => { settingsPage = 'chat'; error = '' }}>返回对话</button></div>
                <p class="ai-assistant-help">可连接多个服务。选择本地命令、远程 HTTP 或旧版 SSE。</p>
                {#each config.mcpServers as server (server.id)}
                    <div class="ai-assistant-mcp-row">
                        <span><strong>{server.id}</strong><small>{server.transport === 'streamable-http' ? 'Streamable HTTP' : server.transport === 'sse' ? 'SSE' : 'stdio'} · {connected.includes(server.id) ? `${tools.filter((tool) => tool.serverId === server.id).length} 个工具` : '未连接'}</small></span>
                        {#if connected.includes(server.id)}
                            <button type="button" disabled={busy || mcpPending.includes(server.id)} onclick={() => void disconnectMcp(server.id)}>断开</button>
                        {:else}
                            <button type="button" disabled={busy || mcpPending.includes(server.id)} onclick={() => void connectMcp(server)}>{mcpPending.includes(server.id) ? '连接中…' : '连接'}</button>
                        {/if}
                        <button type="button" disabled={busy || mcpPending.includes(server.id)} onclick={() => void removeMcpServer(server.id)}>删除</button>
                    </div>
                {/each}
                <h3>添加服务</h3>
                <label>服务 ID<input bind:value={mcpId} placeholder="local" /></label>
                <label>连接方式
                    <select bind:value={mcpTransport}>
                        <option value="stdio">本地命令（stdio）</option>
                        <option value="streamable-http">远程 Streamable HTTP</option>
                        <option value="sse">远程 SSE（旧版）</option>
                    </select>
                </label>
                {#if mcpTransport === 'stdio'}
                <label>可执行命令<input bind:value={mcpCommand} placeholder="node 或本地 MCP 服务程序路径" /></label>
                <label>参数 JSON 数组<input bind:value={mcpArguments} placeholder={'["server.mjs"]'} /></label>
                <label>工作目录（可选）<input bind:value={mcpCwd} /></label>
                <label>环境变量 JSON<input bind:value={mcpEnvironment} placeholder={'{"KEY":"value"}'} /></label>
                {:else}
                <label>{mcpTransport === 'sse' ? 'SSE 地址' : 'MCP 地址'}<input type="url" bind:value={mcpUrl} placeholder={mcpTransport === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'} /></label>
                <label>请求头 JSON（可选）<textarea bind:value={mcpHeaders} rows="3" placeholder={'{"Authorization":"Bearer token"}'}></textarea></label>
                {/if}
                <button type="button" onclick={addMcpServer}>添加服务</button>
            </div>
            {/if}
        </div>
        {#if error}<div class="ai-assistant-error" role="alert">{error}</div>{/if}
    {:else}
    <div class="ai-assistant-feed" bind:this={feed} role="log" aria-live="polite">
        {#if messages.length === 0}
            <div class="ai-assistant-empty">询问终端问题，或选择命令生成、解释与错误分析。命令只会插入终端，不会自动执行。</div>
        {/if}
        {#each messages as message (message.id)}
            <div class="ai-assistant-message" class:user={message.role === 'user'}>
                <span class="ai-assistant-role">{message.role === 'user' ? '你' : 'AI 助手'}</span>
                <div class="ai-assistant-text">{message.content}</div>
                {#if message.contextText}
                    <details class="ai-assistant-context-sent"><summary>本轮发送的终端上下文（脱敏）</summary><pre>{message.contextText}</pre></details>
                {/if}
                {#each message.toolCalls ?? [] as trace (trace.id)}
                    <div class="ai-assistant-tool-call" class:failed={trace.status === 'error' || trace.status === 'denied'}>
                        <div class="ai-assistant-tool-heading"><strong>{trace.serverId} · {trace.toolName}</strong><span>{traceStatus(trace)}</span></div>
                        <small>调用 {trace.callNumber}/{MAX_TOOL_CALLS} · 耗时 {trace.durationMs} ms（含确认）</small>
                        <details><summary>参数（脱敏）</summary><pre>{trace.argumentsText}</pre></details>
                        {#if trace.resultText}
                            <div class="ai-assistant-tool-summary">{trace.resultText.slice(0, 240)}{trace.resultText.length > 240 ? '…' : ''}</div>
                            <details><summary>完整结果{trace.truncated ? '（超过上限，已截断）' : ''}</summary><pre>{trace.resultText}</pre></details>
                        {/if}
                    </div>
                {/each}
                {#if message.command}
                    <div class="ai-assistant-command"><code>{message.command}</code><span>风险：{assessCommand(message.command)}</span></div>
                    <button type="button" disabled={assessCommand(message.command) === 'critical'} onclick={() => void insert(message)}>插入当前终端</button>
                {/if}
            </div>
        {/each}
        {#if busy}<div class="ai-assistant-wait" role="status">正在处理本轮请求…工具最多 {MAX_TOOL_CALLS} 次，模型最多 {MAX_MODEL_ROUNDS} 回合。</div>{/if}
    </div>
    {#if error}<div class="ai-assistant-error" role="alert">{error}</div>{/if}
    <div class="ai-assistant-compose">
        <select bind:value={mode} disabled={busy} aria-label="操作模式">
            <option value="chat">对话</option>
            <option value="command">生成命令</option>
            <option value="explain">解释命令</option>
            <option value="fix">分析错误</option>
        </select>
        <div class="ai-assistant-context-picker">
            <label class="ai-assistant-check"><input type="checkbox" bind:checked={config.includeTerminalContext} disabled={busy} onchange={persist} />附加终端上下文</label>
            {#if config.includeTerminalContext}
                <select bind:value={contextSource} disabled={busy} aria-label="终端上下文来源">
                    {#each Object.entries(CONTEXT_SOURCES) as [value, label]}<option value={value}>{label}</option>{/each}
                </select>
                {#if contextSource === 'recent'}
                    <select bind:value={recentLines} disabled={busy} aria-label="最近输出行数"><option value={50}>最近 50 行</option><option value={100}>最近 100 行</option><option value={500}>最近 500 行</option></select>
                {/if}
            {/if}
        </div>
        {#if tools.length}
            <details class="ai-assistant-tool-picker">
                <summary>本轮 MCP 工具：已启用 {enabledTools.length}/{tools.length}（最多 {MAX_MCP_TOOLS}）</summary>
                <input type="search" bind:value={toolSearch} aria-label="搜索 MCP 工具" placeholder="搜索服务、工具或描述" />
                <div class="ai-assistant-tool-actions"><button type="button" disabled={busy} onclick={clearToolSelection}>清除选择</button><button type="button" disabled={busy} onclick={selectFilteredTools}>选择搜索结果</button></div>
                {#if enabledTools.length > MAX_MCP_TOOLS}<p class="ai-assistant-help">工具超过本轮上限，请取消部分选择后发送。</p>{/if}
                <div class="ai-assistant-tool-list">
                    {#each filteredTools as tool (mcpToolKey(tool))}
                        <label class="ai-assistant-tool-option"><input type="checkbox" disabled={busy} checked={enabledToolIds.includes(mcpToolKey(tool))} onchange={(event) => toggleTool(tool, event.currentTarget.checked)} /><span><strong>{tool.serverId} · {tool.name}</strong><small>{tool.description ?? '无描述'}</small></span></label>
                    {/each}
                    {#if filteredTools.length === 0}<p class="ai-assistant-help">没有匹配的工具。</p>{/if}
                </div>
            </details>
        {/if}
        <textarea bind:value={input} disabled={busy} onkeydown={onInputKey} placeholder="输入问题或命令；Ctrl+Enter 预览 / 发送" rows="3"></textarea>
        {#if preview}
            <section class="ai-assistant-preview" aria-label="发送前脱敏预览">
                <div class="ai-assistant-tool-heading"><strong>本轮发送预览（已脱敏）</strong><button type="button" disabled={busy} onclick={preparePreview}>刷新预览</button></div>
                {#if !previewIsCurrent}<p class="ai-assistant-help">问题、上下文来源或工具选择已变化，请刷新预览。</p>{/if}
                {#if preview.warning}<p class="ai-assistant-help">{preview.warning}</p>{/if}
                <pre>{preview.text}</pre>
                {#if preview.skillText}
                    <details class="ai-assistant-skill-preview"><summary>本轮注入 system 的技能部分</summary><pre>{preview.skillText}</pre></details>
                {/if}
                <small>发送使用以上快照；终端产生新输出时可点击刷新预览。</small>
            </section>
        {/if}
        <button type="button" disabled={busy || !input.trim()} onclick={() => void submit()}>{previewIsCurrent ? '发送预览内容' : '预览发送内容'}</button>
    </div>
    {/if}
</div>
