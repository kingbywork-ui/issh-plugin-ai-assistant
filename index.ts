import { mount, unmount } from 'svelte'
import AssistantPanel from './src/AssistantPanel.svelte'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/plugin-api'
import { setPluginContext } from './src/assistant'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-ai-assistant',
    name: 'AI 助手',
    version: '0.2.0',
    description: '多模型流式对话、本地 MCP 工具、终端上下文分析与命令辅助',
    kind: 'feature',
    entry: 'index.js',
    minAppVersion: '0.0.6',
    gatewayApiVersion: '2',
    capabilities: ['ui.panel.register', 'terminal.read', 'terminal.write', 'network.postJson', 'mcp.stdio'],
    permissions: ['panel:register', 'terminal:read', 'terminal:write', 'network:postJson', 'mcp:stdio'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-ai-assistant',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-ai-assistant',
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        setPluginContext(ctx)
        ctx.gateway.ui.registerPanel({
            id: 'ai-assistant',
            title: 'AI 助手',
            placement: 'right',
            mount: (target, host) => {
                const instance = mount(AssistantPanel, { target, props: { host } })
                return () => { void unmount(instance) }
            },
        })
        ctx.gateway.log('info', 'AI assistant activated')
    },
}

export default plugin
