# 聊天接口：JSON 与流式协议

## 配置状态

`GET /api/chat` 返回 `{ "configured": true | false }` 与 `Cache-Control: no-store`。
它不验证访问口令，只说明部署是否具备必需配置，不返回密钥、令牌或模型 ID。

## 发送消息

`POST /api/chat` 要求 `Content-Type: application/json` 和
`Authorization: Bearer <独立访问口令>`。上游模型密钥仅保留在服务端。

```json
{
  "messages": [
    { "role": "user", "content": "你好" }
  ]
}
```

角色从 `user` 开始严格交替，以 `user` 结束。最多 40 条、32,000 字符、64 KiB 序列化 UTF-8；
单条用户消息最多 8,000 字符。服务端只转发规范化的 `role` 和 `content`。
所有 POST 响应都带有服务端生成的 `X-Request-ID`，且不缓存。

### JSON 调用方

省略 `Accept` 或使用 `Accept: application/json`，成功返回：

```json
{ "content": "你好，有什么可以帮你？" }
```

### 流式调用方

使用 `Accept: text/event-stream`，成功建立流后返回 `Content-Type: text/event-stream; charset=utf-8`，
`Cache-Control: no-store, no-transform`。浏览器使用支持 POST 与鉴权头的 `fetch` 读取响应体。

每个事件以空行结束，`data` 是 JSON。下面的请求编号仅作格式示例：

```text
event: start
data: {"requestId":"example-request-id"}

event: text-delta
data: {"delta":"你好，"}

event: text-delta
data: {"delta":"有什么可以帮你？"}

event: done
data: {}

```

`start.requestId` 与 `X-Request-ID` 相同。`delta` 是增量文本，不能用后一段覆盖前一段。
收到 `done` 且累积文本非空，才能保存为成功轮次。一个 UTF-8 字符或 SSE 事件可能跨多个网络块；
读取方必须增量解码并按事件边界解析。

HTTP 200 已经发出后的错误无法修改状态码，会使用终止 `error` 事件：

```text
event: error
data: {"error":"回复传输中断，请重试","code":"incomplete_stream","requestId":"example-request-id"}

```

错误之后不会再发送 `done`。仅收到 EOF 也视为失败；页面可以保留并标注部分文字，但不得将其放进后续模型上下文。
客户端取消 Fetch 会关闭响应体并向 SDK 传播取消信号；需要重试时由用户显式触发，不自动重试模型调用。

## 状态和公开错误

| 场景 | 尚未建立 SSE 的 HTTP 状态 | 已建立 SSE |
| --- | ---: | --- |
| 请求格式、角色或字符上限不合法 | 400 | 在开始流之前拦截 |
| 独立访问口令无效 | 401 | 在开始流之前拦截 |
| 请求体超过 64 KiB | 413 | 在开始流之前拦截 |
| 上游限流 | 429 | `error` / `upstream_rate_limit` |
| 上游认证失败 | 502 | `error` / `upstream_auth` |
| 上游故障 | 502 | `error` / `upstream_unavailable` |
| 部署配置未完成 | 503 | 在开始流之前拦截 |
| 超过服务端 50 秒截止时间 | 504 | `error` / `upstream_timeout` |
| 空文本、纯工具响应 | JSON 模式 502 | `error` / `empty_reply` |
| 回复超过 32,000 字符 | JSON 模式 502 | `error` / `reply_too_large` |
| 未见供应商完成事件即 EOF | 不适用 | `error` / `incomplete_stream` |

错误 JSON 使用 `error` 提供公开说明；模型错误另外带 `code` 和 `requestId`。
鉴权、配置和输入错误的请求编号从响应头读取。实际断开连接时，调用方可能收不到任何错误响应。
工具调用执行、持久化会话和多用户鉴权当前未实现。
