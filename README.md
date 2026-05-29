# 个人 Claude Chat 网站

免费部署的 Claude 聊天界面，使用 Next.js + Vercel。

## 本地运行

```bash
# 安装依赖
npm install

# 复制环境变量并填入你的 API Key
cp .env.example .env.local

# 启动开发服务器
npm run dev
```

打开 http://localhost:3000

## 部署到 Vercel（免费）

1. 把代码推到 GitHub 仓库
2. 去 [vercel.com](https://vercel.com) 注册登录
3. 点 "New Project" → 导入你的 GitHub 仓库
4. 在 Environment Variables 里添加：
   - `ANTHROPIC_API_KEY` = 你的 API Key
   - `CLAUDE_MODEL` = `claude-sonnet-4-20250514`（可选，默认就是这个）
5. 点 Deploy，完成！

之后每次 `git push` 都会自动重新部署。

## 费用

- **Vercel 托管**：免费（Hobby 计划完全够用）
- **Claude API**：按 token 计费，Sonnet 4 输入 $3/百万token，输出 $15/百万token
- **域名**：免费用 Vercel 提供的 `xxx.vercel.app`，或自己买域名绑定
