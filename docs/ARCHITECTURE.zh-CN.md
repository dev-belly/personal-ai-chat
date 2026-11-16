# 架构决策：类型契约与标准 AI 消息流

当前技术版本按 **2026-11-16** 的正式发布版本核对：Next.js 16.4.6、React 19.3.1、
TypeScript 7.0.2、AI SDK 7.0.173、Zod 4.6.7。精确版本由 `package-lock.json` 固定。

## 可运行的请求链路

```mermaid
flowchart TD
  Page["Server Component 页面"] --> Client["React 客户端与会话状态"]
  Client -->|"UIMessage Stream v1"| API["Next.js BFF 与鉴权"]
  API --> Schema["Zod 输入契约与回复策略"]
  API --> Core["AI SDK 7 模型层"]
  Core --> Anthropic["Anthropic 协议"]
  Core --> Compatible["OpenAI 兼容协议"]
```

浏览器通过 AI SDK 的 `DefaultChatTransport` 和 `readUIMessageStream` 处理标准消息流。
供应商响应由 AI SDK 归一化成文本事件，经过应用的空回复、长度与完整性策略后，才编码给浏览器。
原有 `/api/chat` JSON 与具名 SSE 继续可用，新浏览器路径为 `/api/chat/ui`。

| 文件 | 负责什么 |
| --- | --- |
| `app/page.tsx`、`app/layout.tsx` | Server Component 页面边界、文档元数据和全局样式 |
| `app/components/chat-app.tsx` | 模式、访问口令和消息展示；浏览器存储留在客户端 |
| `app/hooks/use-chat.ts`、`lib/chat-state.ts` | 请求代次、取消、完成/失败状态与清空隔离 |
| `lib/chat-contract.ts` | Zod Schema、推导类型、文本/标准 UI 消息转换与共同上限 |
| `lib/chat-client.ts` | 完整轮次裁剪；按实际 UI 信封计算 UTF-8 字节预算 |
| `lib/chat-ui-transport.ts` | 官方 AI SDK 传输/读取器；验证请求元数据、完成事件和帧预算 |
| `lib/chat-transport.ts`、`lib/chat-protocol.ts` | 兼容旧 JSON / 具名 SSE 的读取与编码 |
| `app/api/chat/route.ts`、`app/api/chat/ui/route.ts` | 动态配置状态、兼容接口与标准消息流接口 |
| `lib/server/chat-handler.ts` | 同一套鉴权、输入校验、请求编号、回复策略及两种流编码 |
| `lib/chat-validation.ts`、`lib/server/chat-service.ts` | 实际读取字节限制、令牌比较、回复上限、公开错误与截止时间 |
| `lib/server/model-provider.ts` | 显式模型实例；配置解析、两种供应商适配、AI SDK generateText / streamText |

## 类型约束进入运行与 CI

生产页面、Hook、协议和服务端源码均为 TypeScript。`strict`、`noUncheckedIndexedAccess`、
`erasableSyntaxOnly` 开启，`allowJs` 关闭；CI 在构建前独立执行 `npm run typecheck`。
Node.js 22.18+ 可直接执行可擦除的 `.ts` 模块，测试和 Next.js 构建使用相同源码。

共享 Zod Schema 同时产生 TypeScript 类型并验证实际输入。标准 UI 接口仅接受 user / assistant
文本 parts；system、工具、文件和额外可执行字段不能被静默提升为模型上下文。
UI 信封的 ID、parts 和转义开销也计入 64 KiB 请求预算。

React Compiler 通过 `next.config.ts` 开启，参与实际生产与 Workers 构建。
Server Component 外壳与客户端交互组件分别维护；浏览器存储和请求生命周期均留在客户端。
性能变化尚未进行基准测量。

## 模型层显式选择供应商

`CHAT_PROVIDER` 仅由部署环境设置，支持 `anthropic` 和 `openai-compatible`。
默认保留原来的 `CLAUDE_MODEL` / `ANTHROPIC_*` 配置；Anthropic 基址统一为带 `/v1` 的地址，
已经包含 `/v1` 时不重复追加。OpenAI 兼容服务填写实际 Chat Completions API 基址及模型 ID。

两种适配器通过 AI SDK 7 的同一接口生成文本。使用 provider 实例，避免裸模型字符串自动走 AI Gateway。
浏览器不能选择密钥、上游地址或模型。HTTP 请求重试和流内重试都设为零，失败由用户显式重试。
第三方兼容网关的模型能力仍需在对应服务核对；本项目没有宣称所有网关完全兼容。

## 完成、取消与资源生命周期

标准协议是 `start`、`text-start`、`text-delta`、`text-end`、`finish`；尾部 `[DONE]` 是 SSE
传输终止标记。应用必须收到有效 `finish` 且文本非空，才把本轮标为成功；仅有 `[DONE]` 或 EOF 不足以提交。
上游 SDK 报告 `interrupted`、错误或缺失终止原因时，半截文字仍以“未完成回复”留在页面。
旧协议的成功标记为 `done`，两种编码共享同一回复策略。

服务端先读取到上游首个文本或终止事件，再建立流，以便在开流前保留上游 401 / 429 对应的公开 HTTP 状态。
响应按 `ReadableStream.pull()` 读取经过校验的下一段。取消不创建后台消费副本，直接通过信号和迭代器清理传播到模型连接。

- 服务端截止时间为 50 秒，覆盖请求体读取和上游流式回复；浏览器等待上限为 60 秒。
- 服务端与浏览器均限制回复为 32,000 字符；标准流的单帧字节在 SDK 解析前受限。
- 完成、失败、取消均释放定时器和父信号监听；模型迭代器退出时中止剩余读取。
- 页面纯函数 reducer 和递增请求代次同时隔离旧回调，新会话不会接收旧文字。
- 取消传播到实际供应商后是否停止计费，仍由供应商决定。

## 验证与当前边界

`npm test` 覆盖标准/兼容消息流、错误、终止、取消、Schema、上下文预算和会话状态。
`npm run check:http` 的 33 项检查经过生产 Next.js、AI SDK 和回环地址的模型替身；
Anthropic、OpenAI 兼容两种协议分别验证鉴权和连接关闭。首段文字必须在检查放行上游结尾前到达，
避免把一次性完整输出误当成增量流。

`npm run check:browser` 用 Chromium 验证标准协议的实际页面交互、取消重试、未完成回复、
清空后立即发送和 390px 手机布局。Node.js 和 Workers 构建、依赖审计同样进入 CI。
请求失败日志只保存请求编号、公开错误码和状态，不保存提示词、回复、密钥或 SDK 错误体。

当前是单用户、页面内存会话。多用户账号、持久化、工具执行、RAG 和跨请求续传尚未实现。
真实模型与线上 Workers 的运行行为需在实际部署环境验收，本地替身检查不等于生产模型验收。

## 官方资料

- [Next.js 16.4 与 React 19.3](https://nextjs.org/blog/next-16-4)
- [React Compiler 配置](https://nextjs.org/docs/app/api-reference/config/next-config-js/reactCompiler)
- [AI SDK 7](https://ai-sdk.dev/docs/introduction)
- [标准传输](https://ai-sdk.dev/docs/ai-sdk-ui/transport)与[UIMessage 读取器](https://ai-sdk.dev/docs/ai-sdk-ui/reading-ui-message-streams)
- [Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)与[OpenAI 兼容 provider](https://ai-sdk.dev/providers/openai-compatible-providers)
