# Personal AI Chat

一个默认私有的个人 AI 聊天应用，使用 **Next.js 16.4 + React 19.3 + TypeScript 7 + AI SDK 7**，通过模块化 BFF 接入 Anthropic 或 OpenAI 兼容服务，支持 Cloudflare Workers（OpenNext）。

真实模式支持逐段显示回复；取消或半途断流会保留并标注未完成内容，只有完整成功的轮次进入后续上下文。

## 先试用，再连接模型

首次打开默认进入**本地模拟**，无需 API Key 或访问口令。回复由浏览器内置规则选择，每条均标记“本地模拟 · 固定示例”；消息不会发送到模型 API。这用于体验输入、取消、新建会话等流程，不代表 AI 推理能力。

选择“真实服务”后，页面先检查部署是否完成配置；缺少配置时会明确显示原因并保持发送禁用。配置完成后输入独立访问口令，即可连接实际模型。请求失败可重试，取消/新建会话/切换模式不会把旧响应写进新会话；中文输入法确认文字时不会误发送。

[架构与设计取舍](docs/ARCHITECTURE.zh-CN.md) · [JSON / SSE 接口协议](docs/API.zh-CN.md) · [工程实现与验证](docs/ENGINEERING.zh-CN.md)

源码将 Server Component 页面、交互组件、会话状态、标准消息流、HTTP 编排和模型适配器分开。Zod 4 Schema 同时约束运行时输入和 TypeScript 类型；React Compiler 已在生产构建中启用。

| 层 | 当前实现 |
| --- | --- |
| 页面 | Next.js 16.4.6 / React 19.3.1，Server Component 外壳与客户端交互边界 |
| 类型与契约 | TypeScript 7.0.2 strict、noUncheckedIndexedAccess；Zod 4.6.7 |
| AI 接入 | AI SDK 7.0.173；显式配置 Anthropic 与 OpenAI 兼容适配器 |
| 浏览器协议 | AI SDK DefaultChatTransport / UIMessage Stream v1；旧 JSON / SSE 保留 |

版本按 2026-11-16 发布状态核对并固定在锁文件，升级需通过完整 CI。

## 安全设计

- 浏览器只保存独立的 `CHAT_ACCESS_TOKEN`，不会接触上游 API Key。
- `/api/chat` 与 `/api/chat/ui` 默认拒绝未配置或未携带访问口令的请求。
- 服务端限制请求体、消息数量和文本长度，避免匿名滥用与意外高额消耗。
- 上游错误不会把内部错误详情直接返回浏览器。
- 公开的 GET `/api/chat` 仅返回配置是否就绪，不返回密钥、模型 ID 或访问口令。

`CHAT_ACCESS_TOKEN` 不是 `ANTHROPIC_API_KEY`。请生成 32—256 个可见 ASCII 字符的随机口令（例如随机十六进制字符串），不要使用中文、空格或换行，以便安全放入 HTTP 请求头。部署后在页面右上角输入；它只保存在当前浏览器会话中。

## 本地运行

要求 Node.js 22.18 或更高版本；Node 测试直接运行可擦除类型的 TypeScript 源码。

```bash
npm ci
npm run typecheck
npm test
npm run dev
# 打开 http://localhost:3000，立即使用本地模拟
```

连接真实模型时，再复制 `.env.example` 为 `.env.local` 并填写：

- `ANTHROPIC_API_KEY`：上游服务密钥。
- `CLAUDE_MODEL`：上游实际支持的模型 ID；项目不再使用可能失效的硬编码默认值。
- `CHAT_ACCESS_TOKEN`：你自己生成的页面访问口令。
- `ANTHROPIC_BASE_URL`：可选；不填时使用 Anthropic 官方 API。

OpenAI 兼容服务使用以下环境变量（模型必须填写该服务实际支持的 ID）：

```dotenv
CHAT_PROVIDER=openai-compatible
CHAT_MODEL=
OPENAI_COMPATIBLE_BASE_URL=https://your-provider.example/v1
OPENAI_COMPATIBLE_API_KEY=
CHAT_ACCESS_TOKEN=
```

默认 `CHAT_PROVIDER=anthropic`，沿用 `CLAUDE_MODEL` 与 `ANTHROPIC_*` 配置；也可用 `CHAT_MODEL` 指定模型。
供应商和地址仅由部署环境选择，浏览器不能覆盖。使用显式 provider 实例，不会因模型字符串而自动切换到 AI Gateway。

## Cloudflare Workers 预览与部署

该项目是动态 Next.js 应用，应部署到 Cloudflare Workers，不是静态 Pages 目录。

```bash
npm run check
npm run preview
```

首次部署前，通过 Wrangler 配置生产 secrets（命令会安全地交互读取值）：

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CLAUDE_MODEL
npx wrangler secret put CHAT_ACCESS_TOKEN
# 使用兼容网关时再设置：
npx wrangler secret put ANTHROPIC_BASE_URL
```

使用 OpenAI 兼容服务时，应通过同一 `wrangler secret put` 方式设置 `CHAT_PROVIDER`、`CHAT_MODEL`、`OPENAI_COMPATIBLE_BASE_URL`、`OPENAI_COMPATIBLE_API_KEY` 和 `CHAT_ACCESS_TOKEN`。

然后部署：

```bash
npm run deploy
```

Windows 用户也可以运行 `./deploy-cloudflare.ps1`；脚本不会读取、显示、提交或推送本地密钥。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run check:http
npm run build:worker
npm audit
```

GitHub Actions 会在每次推送和 Pull Request 上执行测试、依赖审计、浏览器检查及双重构建。

首次运行浏览器验收时安装对应 Chromium：

```bash
npx playwright install chromium
npm run check:browser
```

浏览器检查通过生产 Next.js 服务和本地模型替身，覆盖流式显示、取消重试、未完成回复、清空后立即发送与 390px 手机布局；使用测试口令，不调用真实模型。Linux 如缺少系统库可使用 `npx playwright install --with-deps chromium`。

`check:http` 使用已有生产构建，启动真实 Next.js 服务和回环地址上的模型替身，检查 33 项接口行为。
它覆盖配置、口令、请求校验、中文消息、上游错误，以及 JSON / 旧 SSE / 标准 UI 消息流中的空内容、断流和超大回复；两种模型协议分别验证请求鉴权和取消传播。
流式替身在检查放行前只发送第一段，验证完整答案结束前已有文本到达；取消检查等待上游连接真正关闭。
全程使用测试口令，不调用真实模型、不需要 `.env.local`，也不会发布网站。
上游没有返回有效文本时，接口在开始流前返回 502，或在流内发送错误，页面保留失败与重试状态，不将占位文字写入后续模型上下文。

依赖审计包含生产包与构建工具。`package.json` 将 Express 的 `body-parser` 和 Miniflare 的 `undici` 分别固定到同一主版本内已修复的 2.4.0 和 7.30.1。上游依赖更新后可评估移除这些定向覆盖；调整覆盖后需要重新验证 Next.js 与 Worker 两种构建。

OpenNext 构建链中的 `glob` 另以定向覆盖固定为 14.0.6，锁文件解析到 `minimatch` 11.0.8，处理
[glob](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4) 与
[minimatch](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249) 的公开问题。
该覆盖跨越了间接依赖的主版本，因此额外用 OpenNext 实际引用的压缩器验证字符串与数组通配符输入，
执行压缩后的 JavaScript 核对行为，并重新验证生产与 Workers 构建。

聊天内容仅保留在当前页面。真实请求最多携带最近 40 条 / 32,000 字符以内的完整对话轮次，并按序列化后的 UTF-8 请求体保持在 64 KiB 以内；中文或转义字符较多时会提前移除最旧的完整轮次。失败的发送不进入后续模型上下文。单条输入最多 8,000 字符。取消会停止浏览器等待并向上游 SDK 传播中止信号；实际模型服务是否停止计费取决于供应商。

服务端为每次 POST 返回 `X-Request-ID`，上游错误日志仅保留编号、公开错误码和状态。流式模式使用 50 秒服务端截止时间、明确的完成事件和 32,000 字符回复上限；原有 JSON 调用方式继续可用。

Next.js 可运行于 Vercel；仓库的 Workers 构建使用 OpenNext。线上部署是否包含某次源码修改，需核对部署提交及实际页面，构建通过本身不代表已经上线。
