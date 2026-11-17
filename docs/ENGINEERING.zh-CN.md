# 页面、接口与验证

Personal AI Chat 将 Next.js / React 页面和模型代理路由放在同一仓库。
默认本地模拟用于试用界面；真实模式通过模块化 BFF 接入模型并逐段显示回复。

[架构决策与源码边界](ARCHITECTURE.zh-CN.md) · [JSON / SSE 接口契约](API.zh-CN.md)

## 从一次发送读代码

| 环节 | 实现 | 需要保持的行为 |
| --- | --- | --- |
| 输入与页面状态 | [app/components/chat-app.tsx](../app/components/chat-app.tsx)、[use-chat.ts](../app/hooks/use-chat.ts) 和 [chat-state.ts](../lib/chat-state.ts) | 中文输入法确认不误发送；等待、取消、失败重试与新会话有明确状态。 |
| 本机会话 | [conversation-store.ts](../lib/local/conversation-store.ts) 与 [use-conversation-history.ts](../app/hooks/use-conversation-history.ts) | 主动保存、刷新后打开、标题搜索、版本冲突、删除和导出；存储回调不影响新会话。 |
| 回复展示 | [message-markdown.tsx](../app/components/message-markdown.tsx) | 流式 Markdown、表格、高亮代码复制；链接协议限制与外部图片替代文字。 |
| 历史上下文 | [lib/chat-client.ts](../lib/chat-client.ts) | 仅保留成功的完整轮次，删除最旧的整轮以满足消息数、字符数和序列化字节限制。 |
| 配置与鉴权 | [chat-handler.ts](../lib/server/chat-handler.ts) | 浏览器使用独立访问口令；上游 API Key 只由服务端读取。 |
| 请求体与角色契约 | [lib/chat-validation.ts](../lib/chat-validation.ts) | 累计实际读取字节；限制消息长度和总字符数；角色从 user 开始交替并以 user 结束。 |
| 模型边界 | [model-provider.ts](../lib/server/model-provider.ts) 与 [chat-service.ts](../lib/server/chat-service.ts) | 透传请求取消信号，设置超时，不自动重试；将内部错误转成可重试的公开错误。 |

生产源码均为 strict TypeScript，Zod Schema 同时定义运行时输入与推导类型；CI 先执行 `typecheck`。

页面用递增的请求代次和纯函数 reducer 隔离会话。清空或切换模式会使旧标识失效，较晚返回的响应不能覆盖新会话。
失败请求和未完成文本留在页面以供重试，但不进入下一次模型上下文。
浏览器默认使用标准 UI 协议，必须见到 `finish` 才提交成功轮次；兼容 SSE 必须见到 `done`。普通连接结束不能冒充完成。
聊天默认在页面内；用户点击保存后写入本浏览器的 IndexedDB。没有服务端会话库或跨设备同步。
摘要和正文在同一 Dexie 事务内提交，更新/删除比较修订号。详见[本机会话设计](LOCAL_CONVERSATIONS.zh-CN.md)。

## JSON 模式 HTTP 返回契约

浏览器使用 SSE；下表保留 JSON 模式和开始流前的状态语义。流建立后的错误使用 `error` 事件，完整协议见 [API 文档](API.zh-CN.md)。

| 场景 | HTTP 状态 | 对调用方的意义 |
| --- | ---: | --- |
| GET 配置状态 | 200 | 仅返回 `configured`，并使用 `Cache-Control: no-store`。 |
| 有效文本回复 | 200 | 返回 `content`；页面才会保存成功轮次。 |
| JSON、角色或长度不合法 | 400 | 修正输入后再发送。 |
| 独立访问口令不匹配 | 401 | 检查页面访问口令。 |
| 请求体超过 64 KiB | 413 | 缩短请求；上游不会被调用。 |
| 上游限流 | 429 | 等待后手动重试。 |
| 上游认证或其他服务错误 | 502 | 返回公开错误，不暴露上游内部详情。 |
| 空内容、纯空白或仅工具块 | 502 | 没有可显示的回复，保留失败与重试状态。 |
| 服务端配置未完成 | 503 | 先完成部署配置；不调用模型。 |
| 上游超过截止时间 | 504 | 结束等待，由用户显式重试。 |

空文本曾被替换成“无响应内容”并返回 200，这会把占位文字当作正常助理回复。
现在仅有实际非空文本才返回成功。工具调用目前没有执行协议，因此纯工具响应也不会冒充文本答案。

## 分别验证工具函数与真实 HTTP

```bash
npm ci
npm run check:text
npm run typecheck
npm test
npm run build
npm run check:http
npm run build:worker
```

`npm test` 检查上下文裁剪、UTF-8 字节预算、输入法和请求校验等可独立行为。
[存储测试](../test/conversation-store.test.mjs)在 fake-indexeddb 中执行真实 Dexie 事务，
包含写入失败回滚、同版本并发只有一个成功、旧修订拒绝覆盖/删除、已删除记录不复活、
读写大小与数据校验，以及访问配置不进入保存字段。
[恢复测试](../test/conversation-restore.test.mjs)验证旧请求动作与重用的请求编号不能改写恢复的记录。
`check:http` 启动生产 Next.js 子进程与两种本地 HTTP 模型替身，检查以下 41 项（按行为分组）：

1. 配置状态不泄露配置值且不缓存。
2. 错误口令被拦截，上游调用数保持为零。
3. 非法 JSON 被拦截。
4. 非法角色顺序被拦截。
5. 超大请求在模型调用前被拦截。
6. 中文消息实际经过 HTTP 和 SDK 到达本地上游，仅转发规范化字段。
7. 上游认证错误转换为 502，隐藏内部错误且不自动重试。
8. 上游限流保留 429，隐藏内部错误且不自动重试。
9. 空内容不能成为成功回复。
10. 空白文本不能成为成功回复。
11. 纯工具响应不能成为成功回复。
12. SSE 鉴权和输入校验在模型调用前执行。
13. 第一段文字在替身收到明确放行前即可到达客户端，且最终正确拼接中文 / emoji。
14. SSE 空内容以公开错误结束，没有 `done`。
15. SSE 空白文本以公开错误结束。
16. SSE 纯工具响应不能成为文本答案。
17. SSE 缺少供应商完成事件不能成为成功回复。
18. SSE 流内错误被隐藏内部详情并公开报告。
19. SSE 超大回复以公开错误结束。
20. SSE 建立前的上游认证错误保留 502 且不自动重试。
21. SSE 建立前的上游限流保留 429 且不自动重试。
22. 客户端取消后，上游替身的真实 HTTP 连接关闭。
23. 官方 UI 传输器经生产 HTTP 增量读取标准文本消息。
24. UI 鉴权和不支持的消息 parts 在调用模型前拦截。
25. UI 缺少完成事件不能保存为成功轮次。
26. UI 流内错误不能保存为成功轮次。
27. UI 空回复不能保存为成功轮次。
28. UI 取消关闭 Anthropic 上游连接。
29. OpenAI 兼容 JSON 路径使用指定基址和私有 Bearer 密钥。
30. 同一个 UI 传输器可以读取 OpenAI 兼容服务。
31. OpenAI 兼容服务的认证失败被公开转换且不重试。
32. UI 取消也关闭 OpenAI 兼容上游连接。
33. 未配置的应用返回 503 且不调用上游。
34. JSON 接口拦截非法 UTF-8 字节，不调用上游。
35. JSON 接口拦截未配对 Unicode 代理项，不调用上游。
36. UI 接口拦截非法 UTF-8 字节，不调用上游。
37. UI 接口拦截未配对 Unicode 代理项，不调用上游。
38. 旧 SSE 拼接上游不同事件中的 emoji 代理项，保持原文。
39. 标准 UI 流拼接上游不同事件中的 emoji 代理项，保持原文。
40. 旧 SSE 不把未完成的 Unicode 回复标为成功。
41. 标准 UI 流不把未完成的 Unicode 回复标为成功。

替身监听 `127.0.0.1` 的随机端口，应用使用脚本生成的测试配置。
脚本退出时停止子进程并关闭连接；不接触真实模型或现有部署。
[CI](../.github/workflows/ci.yml) 在生产构建后运行同一 HTTP 检查，再验证 Workers 构建。

构建链对 `glob` 的定向覆盖使用已修复的 14.0.6，锁定的依赖解析保留 `minimatch` 11.0.8。
[构建依赖测试](../test/build-dependencies.test.mjs)从 OpenNext 的实际依赖树加载压缩器，
验证字符串和数组形式的通配符输入都能找到文件、生成压缩代码，并保持执行结果。
审计与两种构建也进入同一 CI；修改覆盖版本时应一起检查。

这些检查验证 Node.js 生产服务到本地模型边界的请求行为。
`npm run check:browser` 另用 Chromium 检查实际页面的增量显示、取消重试、
未完成回复、新会话与手机布局。新增场景验证主动保存、刷新恢复、JSON 下载、跨标签页冲突与响应式删除、
存储与新会话并发、打开历史时中止流、恢复后的真实上下文、Markdown 表格/高亮/复制、
脚本/危险链接/追踪图片边界，以及存储不可用时聊天仍可使用。
CI 会安装浏览器并执行，保留合成会话的桌面和手机截图。Cloudflare 线上运行和真实模型响应需另行验收。

文字检查和 Unicode 回归用例见[边界说明](TEXT_BOUNDARIES.zh-CN.md)及
[测试源码](../test/text-boundaries.test.mjs)。浏览器另外验证长标题的 emoji、保存后原文恢复，
以及不完整输入被提示、修正后恢复发送；这些行为使用生产页面和本地模型替身。
