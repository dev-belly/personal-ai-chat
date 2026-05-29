# 一键部署脚本 - 在你的 PowerShell 中运行
Write-Host "=== 个人 AI Chat 网站部署脚本 ===" -ForegroundColor Cyan
Write-Host ""

$projectDir = "C:\Users\郭源源\Documents\Codex\2026-05-29\new-chat\personal-ai-site"
Set-Location $projectDir

# Step 1: 用 gh 创建仓库并推送
Write-Host "[1/3] 创建 GitHub 仓库并推送代码..." -ForegroundColor Yellow
& "C:\Program Files\GitHub CLI\gh.exe" repo create personal-ai-chat --public --source=. --remote=origin --push 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "仓库可能已存在，尝试直接推送..." -ForegroundColor DarkYellow
    git push -u origin main 2>&1
}

# Step 2: 安装 Vercel CLI
Write-Host ""
Write-Host "[2/3] 安装 Vercel CLI..." -ForegroundColor Yellow
npm install -g vercel 2>&1

# Step 3: 部署到 Vercel
Write-Host ""
Write-Host "[3/3] 部署到 Vercel（会弹出浏览器登录）..." -ForegroundColor Yellow
vercel --prod --yes 2>&1

# 设置环境变量
Write-Host ""
Write-Host "设置环境变量..." -ForegroundColor Yellow
$envFile = Get-Content ".env.local" -Raw
$apiKey = ($envFile | Select-String "ANTHROPIC_API_KEY=(.+)").Matches.Groups[1].Value
$baseUrl = ($envFile | Select-String "ANTHROPIC_BASE_URL=(.+)").Matches.Groups[1].Value
$model = ($envFile | Select-String "CLAUDE_MODEL=(.+)").Matches.Groups[1].Value

echo $apiKey | vercel env add ANTHROPIC_API_KEY production 2>&1
echo $baseUrl | vercel env add ANTHROPIC_BASE_URL production 2>&1
echo $model | vercel env add CLAUDE_MODEL production 2>&1

# 重新部署以应用环境变量
vercel --prod --yes 2>&1

Write-Host ""
Write-Host "=== 部署完成！===" -ForegroundColor Green
Write-Host "你的网站已经可以在外网访问了！" -ForegroundColor Green