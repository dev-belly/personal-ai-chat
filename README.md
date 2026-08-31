# Personal AI Chat

一个默认私有的个人 AI 聊天界面，使用 Next.js、Anthropic 兼容 API 与 Cloudflare Workers（OpenNext）。

## 安全设计

- 浏览器只保存独立的 `CHAT_ACCESS_TOKEN`，不会接触上游 API Key。
- `/api/chat` 默认拒绝未配置或未携带访问口令的请求。
- 服务端限制请求体、消息数量和文本长度，避免匿名滥用与意外高额消耗。
- 上游错误不会把内部错误详情直接返回浏览器。

`CHAT_ACCESS_TOKEN` 不是 `ANTHROPIC_API_KEY`。请生成一个至少 32 字符的随机口令，部署后在页面右上角输入；它只保存在当前浏览器会话中。

## 本地运行

要求 Node.js 20.9 或更高版本。

```bash
npm ci
cp .env.example .env.local
npm test
npm run dev
```

在 `.env.local` 中填写：

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
