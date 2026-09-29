import { mount, unmount } from 'svelte'
import AssistantPanel from './src/AssistantPanel.svelte'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/plugin-api'
import { setPluginContext } from './src/assistant'
import pluginManifest from './plugin.json'

export const manifest: IsshPluginManifest = pluginManifest as IsshPluginManifest

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
