/** Minimal issh plugin gateway contract used by this standalone plugin repository. */
export interface GatewayRequestOptions {
    timeoutMs?: number
    signal?: AbortSignal
}

export interface PanelHostContext {
    getActiveSession (): { id: string; title: string; kind: string; lines: string[] } | null
}

export interface IsshPluginManifest {
    id: string
    name: string
    version: string
    description: string
    kind: 'feature' | 'appearance' | 'integration'
    entry: string
    minAppVersion?: string
    gatewayApiVersion?: string
    capabilities?: string[]
    permissions?: string[]
    author?: string
    homepage?: string
    repository?: string
}

export interface IsshPluginContext {
    storage: {
        get (key: string): string | null
        set (key: string, value: string): void
        delete (key: string): void
    }
    gateway: {
        ui: {
            registerPanel (panel: { id: string; title: string; placement: 'right'; mount: (target: HTMLElement, host: PanelHostContext) => () => void }): () => void
        }
        http: {
            postJson (url: string, options?: { headers?: Record<string, string>; body?: string } & GatewayRequestOptions): Promise<{ status: number; ok: boolean; body: string }>
            streamOpen (url: string, options?: { headers?: Record<string, string>; body?: string } & GatewayRequestOptions): Promise<{ streamId: string; status: number }>
            streamPoll (streamId: string, options?: GatewayRequestOptions): Promise<{ chunkBase64: string; done: boolean }>
            streamClose (streamId: string, options?: GatewayRequestOptions): Promise<{ closed: boolean }>
        }
        mcp: {
            connect (serverId: string, config: { command: string; arguments?: string[]; cwd?: string; environment?: Record<string, string> }, options?: GatewayRequestOptions): Promise<unknown>
            listTools (serverId: string, options?: GatewayRequestOptions): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>
            callTool (serverId: string, name: string, args: Record<string, unknown>, options?: GatewayRequestOptions): Promise<unknown>
            disconnect (serverId: string, options?: GatewayRequestOptions): Promise<unknown>
        }
        terminal: {
            write (sessionId: string, data: string, options?: GatewayRequestOptions): Promise<unknown>
        }
        log (level: 'info' | 'warn' | 'error', message: string): void
    }
}

export interface IsshPlugin {
    manifest: IsshPluginManifest
    activate (context: IsshPluginContext): void | Promise<void>
    deactivate? (): void | Promise<void>
}
