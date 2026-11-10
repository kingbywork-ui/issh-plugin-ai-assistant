/** Minimal issh plugin gateway contract used by this standalone plugin repository. */

// 与统一 Gateway SDK 重叠的通用类型收敛为 re-export（packages/issh-gateway/src/types）。
export type { GatewayRequestOptions, IsshPluginManifest } from '../../../packages/issh-gateway/src/types'
import type { IsshPluginManifest, PluginGateway, PluginStorage } from '../../../packages/issh-gateway/src/types'

/**
 * 与 SDK 不同构，保留本地形状：
 * - output 为 `string | string[]`（SDK 面板会话内联形状为 `string[]`）；
 * - exitCode 允许 undefined（SDK 为 number | null）。
 * context.ts 的 outputText 依赖该 union，收敛会改变宿主数据适配行为。
 */
export interface TerminalCommandContext {
    command: string
    exitCode?: number | null
    output: string | string[]
}

/**
 * 与 SDK PanelHostContext.getActiveSession 的内联会话形状不同构，保留本地：
 * - cwd/shell/host 为 `string | undefined`（SDK 为 `string | null`）；
 * - lastCommand/lastFailedCommand 允许 undefined（SDK 为 `| null`）；
 * - id/title/kind/lines/selectedText 语义一致。
 */
export interface ActiveSessionContext {
    id: string
    title: string
    kind: string
    lines: string[]
    cwd?: string
    shell?: string
    host?: string
    selectedText?: string
    lastCommand?: TerminalCommandContext
    lastFailedCommand?: TerminalCommandContext
}

/**
 * 与 SDK PanelHostContext 不同构（getActiveSession 返回本插件的 ActiveSessionContext，
 * 见上），保留本地并注明；confirm 签名与 SDK 一致。运行时按宿主实参结构适配，不强行对齐。
 */
export interface PanelHostContext {
    getActiveSession (): ActiveSessionContext | null
    confirm? (message: string, title?: string): Promise<boolean>
}

/**
 * 上下文整体保留本地：ui.registerPanel 的 mount 回调必须携带本插件 PanelHostContext
 * （SDK PanelDefinition 会引入 SDK 面板会话形状，见上）。重叠的 http/mcp/terminal/log
 * 直接取自 SDK PluginGateway；storage 与 SDK PluginStorage 一致（本插件仅用 get/set/delete）。
 */
export interface IsshPluginContext {
    storage: PluginStorage
    gateway: Pick<PluginGateway, 'http' | 'mcp' | 'terminal' | 'log'> & {
        ui: {
            registerPanel (panel: { id: string; title: string; placement: 'right'; mount: (target: HTMLElement, host: PanelHostContext) => () => void }): () => void
        }
    }
}

/**
 * IsshPlugin 保留本地：activate 参数绑定上方本地 IsshPluginContext（SDK IsshPluginContext.gateway.ui
 * 携带 SDK PanelHostContext，与本插件 PanelHostContext 因 getActiveSession 形状不同构而逆变不兼容；
 * 与 SDK 一致的 deactivate 钩子已包含）。manifest 已 re-export SDK。
 */
export interface IsshPlugin {
    manifest: IsshPluginManifest
    activate (context: IsshPluginContext): void | Promise<void>
    deactivate? (): void | Promise<void>
}
