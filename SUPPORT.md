# 试用与问题反馈 / Support

先阅读 [README](README.md)。默认的**本地模拟**使用浏览器内固定示例，不需要 API Key；连接**真实服务**才需要单独配置服务端密钥、模型和访问口令。

## 先定位问题

- 页面输入、取消、新建会话：先在本地模拟中复现，说明浏览器、操作顺序及预期结果。
- 真实服务不可用：记录页面的配置就绪提示、脱敏后的 HTTP 状态，以及使用的源码 commit 和部署 commit；不要粘贴访问口令。
- 本地构建：按 README 使用 Node.js 环境，运行 `npm ci`、`npm test` 和 `npm run build`；Worker 部署相关问题另附 `npm run build:worker` 的脱敏结果。

在[项目 Issues](https://github.com/dev-belly/personal-ai-chat/issues)提供最小复现、环境、commit 和实际检查结果。构建通过不能证明生产部署已更新；取消浏览器等待也不保证上游停止计费。凭据或可利用漏洞请先查看 [安全反馈](SECURITY.md)。

Use the local simulation to isolate UI behavior. Include redacted logs and distinguish a local build from the deployed service.
