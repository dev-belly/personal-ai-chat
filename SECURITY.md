# 安全反馈 / Security

不要在公开 Issue、PR、截图或日志中提交上游 API Key、`CHAT_ACCESS_TOKEN`、环境文件或真实聊天内容。上游密钥与页面访问口令是两种独立凭据；发现泄露后应分别在对应服务或部署配置中撤销、轮换。

报告时请说明受影响的 commit、浏览器或服务端路径、影响及使用合成内容的最小复现。默认本地模拟与真实服务分开描述，避免将第三方模型行为混入本地界面问题。

在本仓库 **Security → Advisories** 中，如有 **Report a vulnerability**，可使用该私密入口。若没有，可在[Issues](https://github.com/dev-belly/personal-ai-chat/issues)仅请求安全联系渠道，不公开漏洞细节或敏感样例。本说明不代表该私密功能已经启用。

Do not publish credentials or private conversation content. Share detailed reproduction material only through an agreed private channel.
