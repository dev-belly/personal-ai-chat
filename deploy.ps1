$ErrorActionPreference = "Stop"

Write-Error "Vercel 自动部署脚本已停用。项目当前使用 Cloudflare Workers；请运行 .\deploy-cloudflare.ps1 或 npm run deploy。"
