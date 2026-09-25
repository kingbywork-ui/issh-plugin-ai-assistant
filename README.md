# issh AI 助手

基于 [issh-ai-assistant](https://github.com/kingbywork-ui/issh-ai-assistant) 的功能设计，为 issh Tauri/Svelte 插件接口重新实现。参考上游提交 `14b1419de251988c35fefde9c97bb656d2d426bd`；上游仍是 Angular/Tabby 插件，不能直接在 issh 桌面端加载。

本插件需要支持 **插件网关 API v2** 的 issh 客户端；旧客户端即使显示 0.0.6，也会在加载前拒绝插件，避免安装后才因缺少 MCP/流式接口报错。

## 功能

- 右侧 AI 助手面板；支持 OpenAI、Anthropic、MiniMax、GLM、Ollama、vLLM 和 OpenAI 兼容接口。
- 对话、单行命令生成、命令解释与错误分析；按终端标签保存最近 60 条消息。
- 可选发送当前终端最近 20 行输出；发送前脱敏，默认关闭。
- 生成命令须由用户点击才插入当前终端，不自动回车执行；中高风险需确认，极高风险拒绝插入。
- API Key 存在 issh 的本地插件存储中，切换服务商时清空输入框中的旧 Key。
- 模型回答按 SSE 增量显示，支持 OpenAI 兼容与 Anthropic 流式格式；发送后可停止。
- 可配置并手动连接本地 stdio MCP 服务，列出工具并交给模型选择；每次实际工具调用都会显示服务、工具名和参数，需用户确认。最多 8 次工具调用、5 个模型回合。关闭面板时断开服务。

本地 MCP 设置示例：服务 ID `local`、可执行命令 `node`、参数 JSON 数组 `["C:\\path\\to\\server.mjs"]`，可选设置工作目录与环境变量 JSON。宿主使用 stdio JSON-RPC 连接本地子进程；`tools/list` 和 `tools/call` 由宿主执行，插件不能直接访问 Node API。工具结果会作为下一轮模型输入。环境变量与 API Key 一样保存在本地插件存储，请按需配置。代理设置尚未移植。

## 开发验证

```powershell
npm.cmd install --no-package-lock
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run package
```

安装包为 `issh-plugin-ai-assistant-0.2.0.tgz`。面板及 MCP/流式网关依赖本仓库新增的宿主代码，旧版 0.0.6 安装程序即使装入插件，也不会出现 AI 助手按钮。源码构建或生成插件包不等于更新已安装程序。
