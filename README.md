# Personal AI Chat

一个默认私有的个人 AI 聊天界面，使用 Next.js、Anthropic 兼容 API 与 Cloudflare Workers（OpenNext）。

## 先试用，再连接模型

首次打开默认进入**本地模拟**，无需 API Key 或访问口令。回复由浏览器内置规则选择，每条均标记“本地模拟 · 固定示例”；消息不会发送到模型 API。这用于体验输入、取消、新建会话等流程，不代表 AI 推理能力。

选择“真实服务”后，页面先检查部署是否完成配置；缺少配置时会明确显示原因并保持发送禁用。配置完成后输入独立访问口令，即可连接实际模型。请求失败可重试，取消/新建会话/切换模式不会把旧响应写进新会话；中文输入法确认文字时不会误发送。

## 安全设计

- 浏览器只保存独立的 `CHAT_ACCESS_TOKEN`，不会接触上游 API Key。
- `/api/chat` 默认拒绝未配置或未携带访问口令的请求。
- 服务端限制请求体、消息数量和文本长度，避免匿名滥用与意外高额消耗。
- 上游错误不会把内部错误详情直接返回浏览器。
- 公开的 GET `/api/chat` 仅返回配置是否就绪，不返回密钥、模型 ID 或访问口令。

`CHAT_ACCESS_TOKEN` 不是 `ANTHROPIC_API_KEY`。请生成一个至少 32 字符的随机口令，部署后在页面右上角输入；它只保存在当前浏览器会话中。

## 本地运行

要求 Node.js 20.9 或更高版本。

```bash
npm ci
npm test
npm run dev
# 打开 http://localhost:3000，立即使用本地模拟
```

连接真实模型时，再复制 `.env.example` 为 `.env.local` 并填写：

- `ANTHROPIC_API_KEY`：上游服务密钥。
- `CLAUDE_MODEL`：上游实际支持的模型 ID；项目不再使用可能失效的硬编码默认值。
- `CHAT_ACCESS_TOKEN`：你自己生成的页面访问口令。
- `ANTHROPIC_BASE_URL`：可选；不填时使用 Anthropic 官方 API。

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

然后部署：

```bash
npm run deploy
```

Windows 用户也可以运行 `./deploy-cloudflare.ps1`；脚本不会读取、显示、提交或推送本地密钥。

## 验证

```bash
npm test
npm run build
npm run build:worker
npm audit --omit=dev
```

GitHub Actions 会在每次推送和 Pull Request 上执行同样的测试、依赖审计及双重构建。

聊天内容仅保留在当前页面。真实请求最多携带最近 40 条 / 32,000 字符以内的完整对话轮次；失败的发送不进入后续模型上下文。单条输入最多 8,000 字符。取消会停止浏览器等待，已提交的上游模型请求是否停止计费取决于服务端。

Next.js 可运行于 Vercel；仓库的 Workers 构建使用 OpenNext。线上部署是否包含某次源码修改，需核对部署提交及实际页面，构建通过本身不代表已经上线。
