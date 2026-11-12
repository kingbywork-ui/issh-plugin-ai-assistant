// 由 scripts/sync-sdk-types.mjs 从 packages/issh-gateway/src/types.ts 同步，请勿手改；SDK 变更后重新执行同步。
// issh 插件 Gateway SDK 的插件侧类型定义。
// 迁移自 issh-tauri/src/lib/plugins/types.ts 的插件侧类型；宿主专属类型
// （InstalledPluginRecord、RegistryEntry 等）留在宿主，不进入 SDK。
// SDK 零依赖：svelte 组件与 xterm Terminal 用下方结构化占位类型表达，
// 不 import svelte / @xterm/xterm / @tauri-apps / issh-tauri 任何包。

export const PLUGIN_GATEWAY_API_VERSION = '1'
export type PluginPermission = string
export type Disposable = () => void

/**
 * Svelte 5 组件的结构化占位：SDK 不依赖 svelte，签名与 svelte `Component` 的
 * 调用形状兼容（`Component<Record<string, unknown>>` 等真实组件均可赋值）。
 * Props 为具体接口类型的组件与宿主侧约束一致，需按 `Component<Record<string, unknown>>` 声明。
 */
export type Component<Props extends Record<string, unknown> = Record<string, unknown>> = (anchor: never, props: Props) => unknown

// ---- xterm 5.4 Terminal 的结构化子集（成员签名与真实类型逐一对齐，宿主传入的真实实例可直接赋值） ----

export interface TerminalBufferCellPosition { x: number; y: number }

export interface TerminalBufferCell {
    getChars (): string
    getWidth (): number
}

export interface TerminalBufferLine {
    readonly isWrapped: boolean
    readonly length: number
    getCell (x: number, cell?: TerminalBufferCell): TerminalBufferCell | undefined
    translateToString (trimRight?: boolean): string
}

export interface TerminalBuffer {
    readonly type: 'normal' | 'alternate'
    readonly length: number
    readonly baseY: number
    readonly cursorX: number
    readonly cursorY: number
    getLine (y: number): TerminalBufferLine | undefined
    getNullCell (): TerminalBufferCell
}

export interface TerminalTheme {
    foreground?: string
    background?: string
    cursor?: string
    cursorAccent?: string
    selectionBackground?: string
    selectionForeground?: string
    selectionInactiveBackground?: string
    black?: string
    red?: string
    green?: string
    yellow?: string
    blue?: string
    magenta?: string
    cyan?: string
    white?: string
    brightBlack?: string
    brightRed?: string
    brightGreen?: string
    brightYellow?: string
    brightBlue?: string
    brightMagenta?: string
    brightCyan?: string
    brightWhite?: string
    extendedAnsi?: string[]
}

/** 绝对缓冲区坐标由宿主填充：1 基、两端 inclusive。 */
export interface TerminalLink {
    text: string
    range: { start: TerminalBufferCellPosition; end: TerminalBufferCellPosition }
    activate (event: MouseEvent, text: string): void
}

export interface Terminal {
    readonly cols: number
    readonly rows: number
    readonly element: HTMLElement | undefined
    readonly buffer: { readonly active: TerminalBuffer }
    options: { theme?: TerminalTheme }
    write (data: string | Uint8Array, callback?: () => void): void
    writeln (data: string | Uint8Array, callback?: () => void): void
    onData (listener: (data: string) => void): { dispose (): void }
    attachCustomKeyEventHandler (handler: (event: KeyboardEvent) => boolean): void
    registerLinkProvider (provider: { provideLinks (bufferLineNumber: number, callback: (links: TerminalLink[] | undefined) => void): void }): { dispose (): void }
    hasSelection (): boolean
    getSelection (): string
    clearSelection (): void
    open (parent: HTMLElement): void
    input (data: string, wasUserInput?: boolean): void
    scrollLines (amount: number): void
    scrollToBottom (): void
    clear (): void
    dispose (): void
}

// ---- 网关选项与插件网关 ----

export interface GatewayRequestOptions {
    signal?: AbortSignal
    timeoutMs?: number
    requestId?: string
}

export interface GatewayNetworkOptions extends GatewayRequestOptions {
    method?: 'GET' | 'POST' | 'PATCH'
    headers?: Record<string, string>
    body?: string
}

export interface PluginGateway {
    apiVersion: '1' | '2' | '3'
    request<T = unknown> (method: string, args?: Record<string, unknown>, options?: GatewayRequestOptions): Promise<T>
    ui: {
        registerSettingsTab (tab: SettingsTabDefinition): Disposable
        registerHomeCard (card: HomeCardDefinition): Disposable
        registerPanel (panel: PanelDefinition): Disposable
        registerSandboxPanel (panel: SandboxPanelDefinition): Disposable
        registerTerminalDecorator (decorator: TerminalDecoratorDefinition): Disposable
    }
    sessions: {
        getCurrent (): Promise<unknown>
        read (sessionId: string, lines?: number, options?: GatewayRequestOptions): Promise<unknown>
        write (sessionId: string, data: string | Uint8Array, options?: GatewayRequestOptions): Promise<unknown>
    }
    terminal: {
        read (sessionId: string, lines?: number, options?: GatewayRequestOptions): Promise<unknown>
        write (sessionId: string, data: string | Uint8Array, options?: GatewayRequestOptions): Promise<unknown>
        /** 订阅会话输出（仅输出，不含键盘输入）；经宿主桥注册，随插件停用自动清理。 */
        onOutput (sessionId: string, listener: (data: Uint8Array) => void, options?: GatewayRequestOptions): Disposable
    }
    profiles: {
        read (options?: GatewayRequestOptions): Promise<unknown>
        mutate (mutation: unknown, options?: GatewayRequestOptions): Promise<unknown>
    }
    vault: {
        status (options?: GatewayRequestOptions): Promise<unknown>
        unlock (passphrase: string, options?: GatewayRequestOptions): Promise<unknown>
        getSecret (id: string, options?: GatewayRequestOptions): Promise<unknown>
    }
    network: {
        fetch (url: string, options?: GatewayNetworkOptions): Promise<{ status: number; ok: boolean; body: string }>
    }
    /** 受控 JSON POST（LLM API 等用户配置端点）：https/http、请求头白名单、大小与超时限制。 */
    http: {
        postJson (url: string, options?: { headers?: Record<string, string>; body?: string } & GatewayRequestOptions): Promise<{ status: number; ok: boolean; body: string }>
        streamOpen (url: string, options?: { headers?: Record<string, string>; body?: string } & GatewayRequestOptions): Promise<{ streamId: string; status: number }>
        streamPoll (streamId: string, options?: GatewayRequestOptions): Promise<{ chunkBase64: string; done: boolean }>
        streamClose (streamId: string, options?: GatewayRequestOptions): Promise<{ closed: boolean }>
    }
    mcp: {
        connect (serverId: string, config: { transport?: 'stdio' | 'streamable-http' | 'sse'; command?: string; arguments?: string[]; cwd?: string; environment?: Record<string, string>; url?: string; headers?: Record<string, string> }, options?: GatewayRequestOptions): Promise<unknown>
        listTools (serverId: string, options?: GatewayRequestOptions): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>
        callTool (serverId: string, name: string, args: Record<string, unknown>, options?: GatewayRequestOptions): Promise<unknown>
        disconnect (serverId: string, options?: GatewayRequestOptions): Promise<unknown>
    }
    /**
     * 本地文件读取（只读）：
     * - readLocalText 仅限 shell 历史文件（路径白名单），缺失返回 null；
     * - listLocalDir 列出 root 下一层条目（不递归，最多 5000 条），root 须为绝对路径，
     *   同时授权该目录供本插件 readLocalFile 读取；root 缺省时尝试 ~/.claude/skills 等常见技能目录，
     *   全部不存在时返回 { root: null, entries: [] }；指向 root 外的符号链接被跳过；
     * - pickSkillDirectory 弹出系统目录选择框，用户选定后授权并返回该目录（/ 分隔），取消返回 null；
     * - readLocalFile 仅读取已授权目录内的 .md 文件，超过 256 KiB、不存在或非 UTF-8 返回 null，
     *   未授权/越界/非 .md 路径抛错。
     */
    fs: {
        userPaths (options?: GatewayRequestOptions): Promise<{ home: string | null; appData: string | null; defaultSkillDirs?: string[] }>
        readLocalText (path: string, options?: GatewayRequestOptions): Promise<string | null>
        listLocalDir (root?: string | null, options?: GatewayRequestOptions): Promise<{ root: string | null; entries: Array<{ name: string; path: string; isDir: boolean; isFile: boolean }> }>
        readLocalFile (path: string, options?: GatewayRequestOptions): Promise<string | null>
        pickSkillDirectory (options?: GatewayRequestOptions): Promise<string | null>
    }
    /** SFTP 文件操作（对接 isshd sftp.* RPC，参数 camelCase）。 */
    sftp: {
        open (sessionId: string, sudoPassword?: string, options?: GatewayRequestOptions): Promise<{ sessionId: string; sftpId: string }>
        read (sessionId: string, path: string, offset?: number, length?: number, options?: GatewayRequestOptions): Promise<{ offset: number; length: number; dataBase64: string; eof: boolean }>
        write (sessionId: string, path: string, dataBase64: string, offset?: number, truncate?: boolean, options?: GatewayRequestOptions): Promise<{ acceptedBytes: number; totalBytes: number }>
        list (sessionId: string, path: string, offset?: number, limit?: number, options?: GatewayRequestOptions): Promise<{ path: string; offset: number; entries: Array<{ name: string; path: string; isDir: boolean; isFile: boolean; isSymlink: boolean; size: number; modifiedUnixSecs: number | null }>; total: number; hasMore: boolean }>
        stat (sessionId: string, path: string, options?: GatewayRequestOptions): Promise<unknown>
        close (sessionId: string, options?: GatewayRequestOptions): Promise<unknown>
        mkdir (sessionId: string, path: string, options?: GatewayRequestOptions): Promise<unknown>
        remove (sessionId: string, path: string, options?: GatewayRequestOptions): Promise<unknown>
        removeDir (sessionId: string, path: string, options?: GatewayRequestOptions): Promise<unknown>
        rename (sessionId: string, oldPath: string, newPath: string, options?: GatewayRequestOptions): Promise<unknown>
        chmod (sessionId: string, path: string, mode: number, options?: GatewayRequestOptions): Promise<unknown>
    }
    events: {
        on (eventName: string, handler: (params: unknown) => void): Disposable
    }
    storage: PluginStorage
    log (level: 'info' | 'warn' | 'error', message: string): void
}

// ---- 清单与界面/终端定义 ----

export interface IsshPluginManifest {
    id: string
    name: string
    version: string
    description: string
    kind: 'feature' | 'appearance' | 'integration'
    minAppVersion?: string
    entry: string
    permissions?: string[]
    dependencies?: Array<string | { id: string; minVersion?: string }>
    author?: string
    homepage?: string
    repository?: string
    gatewayApiVersion?: string
    capabilities?: string[]
    signature?: string
    executionMode?: 'trusted' | 'sandbox'
    sandboxEntry?: string
    /** Isolated plugins default to the legacy bottom panel when omitted. */
    sandboxPlacement?: 'bottom' | 'modal'
}

export interface SettingsTabDefinition {
    id: string
    title: string
    /** 宿主注入的唯一标识（`manifest.id:tab.id`），用于跨插件去重与 Svelte each key */
    key?: string
    order?: number
    /**
     * 宿主导入的 Svelte 组件（内置插件与宿主共享 svelte runtime 时使用）。
     * 外置插件因自带 svelte runtime，跨 runtime 挂载会触发 effect_orphan，应改用 `mount`。
     */
    component?: Component<Record<string, unknown>>
    /**
     * 插件自挂载入口：外置插件用自身打包的 svelte runtime 把组件挂载到 target，
     * 返回销毁函数（卸载时由宿主调用）。
     */
    mount?: (target: HTMLElement) => () => void
}

export interface HomeCardDefinition {
    id: string
    title: string
    order?: number
    component: Component<Record<string, unknown>>
}

export interface PanelDefinition {
    id: string
    title: string
    placement: 'left' | 'bottom' | 'right'
    component?: Component<Record<string, unknown>>
    mount?: (target: HTMLElement, host: PanelHostContext) => () => void
    /** 由宿主按插件权限填充，不接受插件自行声明。 */
    canReadTerminal?: boolean
}

export interface PanelHostContext {
    getActiveSession (): { id: string; title: string; kind: string; lines: string[]; cwd?: string | null; shell?: string | null; host?: string | null; selectedText?: string; lastCommand?: { command: string; exitCode: number | null; output: string[] } | null; lastFailedCommand?: { command: string; exitCode: number | null; output: string[] } | null } | null
    confirm? (message: string, title?: string): Promise<boolean>
}

export interface SandboxPanelDefinition {
    id: string
    title: string
    placement: 'left' | 'bottom' | 'modal'
    sandboxUrl: string
    sandboxOrigin: string
    height?: number
}

export interface TerminalDecoratorDefinition {
    id: string
    decorate (options: TerminalDecoratorOptions): void | Promise<void>
}

export interface TerminalDecoratorProfileInfo {
    name: string
    host: string
    port: number
    user: string
    loginScript: string | null
}

export interface TerminalDecoratorOptions {
    sessionId: string
    kind: 'local' | 'ssh'
    title: string
    terminal: Terminal
    /** SSH 会话关联的主机 profile 摘要（本地会话为 null） */
    profile: TerminalDecoratorProfileInfo | null
    /** 仅订阅之后的会话输出，不含键盘输入；返回幂等取消函数。回调内须复制借用字节，不得持有传入字节；宿主也会自动清理订阅。 */
    onOutput? (listener: (data: Uint8Array) => void): Disposable
    write (data: Uint8Array | string): void
    /** 为当前终端暴露一个可选的上下文操作（例如填充 sudo 密码）。 */
    setAction? (action: { label: string, invoke: () => void } | null): void
    /** 需要临时读取已锁 Vault 中的终端凭据时，请求用户输入主口令。 */
    requestVaultPassphrase? (): Promise<string | null>
    dispose (callback: () => void): void
}

export interface PluginStorage {
    get (key: string): string | null
    set (key: string, value: string): void
    delete (key: string): void
    keys (): string[]
}

export interface IsshPluginContext {
    manifest: IsshPluginManifest
    gateway: PluginGateway
    registerSettingsTab (tab: SettingsTabDefinition): void
    registerHomeCard (card: HomeCardDefinition): void
    registerPanel (panel: PanelDefinition): void
    registerSandboxPanel (panel: SandboxPanelDefinition): void
    registerTerminalDecorator (decorator: TerminalDecoratorDefinition): void
    storage: PluginStorage
    log (level: 'info' | 'warn' | 'error', message: string): void
    /** 插件安装目录（正斜杠分隔）；sandbox.html 等静态资源位于该目录下 */
    directory: string
}

export interface IsshPlugin {
    manifest: IsshPluginManifest
    activate (ctx: IsshPluginContext): void | Promise<void>
    /** 插件停用/卸载时的清理钩子（可选），用于停止后台服务、释放资源等。 */
    deactivate? (): void | Promise<void>
}
