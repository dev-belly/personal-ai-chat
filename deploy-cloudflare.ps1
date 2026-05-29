# ============================================================
#  Cloudflare Pages 一键部署脚本
#  在 PowerShell 中运行: .\deploy-cloudflare.ps1
# ============================================================

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Cloudflare Pages 部署脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$projectDir = "C:\Users\郭源源\Documents\Codex\2026-05-29\new-chat\personal-ai-site"
Set-Location $projectDir

$nodePath = "C:\Program Files\nodejs\node.exe"
$wranglerPath = Join-Path $projectDir "node_modules\wrangler\bin\wrangler.js"

# ---- Step 1: 推送代码到 GitHub ----
Write-Host "[1/5] 推送最新代码到 GitHub..." -ForegroundColor Yellow
git add -A
git commit -m "deploy: update for Cloudflare Pages" 2>$null
git push origin main 2>&1
Write-Host "  -> 代码已推送" -ForegroundColor Green
Write-Host ""

# ---- Step 2: 检查 Cloudflare 登录状态 ----
Write-Host "[2/5] 检查 Cloudflare 登录状态..." -ForegroundColor Yellow
$authCheck = & $nodePath $wranglerPath auth token 2>&1
if ($authCheck -match "ERROR|not authenticated|no credentials") {
    Write-Host "  -> 未登录，正在打开浏览器进行登录..." -ForegroundColor DarkYellow
    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Magenta
    Write-Host "  浏览器会弹出 Cloudflare 登录页面" -ForegroundColor Magenta
    Write-Host "  请在浏览器中完成授权，然后回到这里" -ForegroundColor Magenta
    Write-Host "  ============================================" -ForegroundColor Magenta
    Write-Host ""
    & $nodePath $wranglerPath login 2>&1
    Write-Host ""
    Write-Host "  -> 登录完成" -ForegroundColor Green
} else {
    Write-Host "  -> 已登录 Cloudflare" -ForegroundColor Green
}
Write-Host ""

# ---- Step 3: 构建项目 ----
Write-Host "[3/5] 构建项目（这需要 1-3 分钟）..." -ForegroundColor Yellow
Write-Host "  -> 第一步: next build..." -ForegroundColor DarkYellow
& $nodePath (Join-Path $projectDir "node_modules\next\dist\bin\next") build 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  !! next build 失败，请检查错误信息" -ForegroundColor Red
    exit 1
}
Write-Host "  -> next build 完成" -ForegroundColor Green

Write-Host "  -> 第二步: opennextjs-cloudflare build..." -ForegroundColor DarkYellow
& $nodePath (Join-Path $projectDir "node_modules\@opennextjs\cloudflare\bin\opennextjs-cloudflare.js") 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  !! Cloudflare build 失败，请检查错误信息" -ForegroundColor Red
    exit 1
}
Write-Host "  -> Cloudflare build 完成" -ForegroundColor Green
Write-Host ""

# ---- Step 4: 读取环境变量 ----
Write-Host "[4/5] 读取环境变量..." -ForegroundColor Yellow
$envFile = Get-Content ".env.local" -Raw
$apiKey = ($envFile | Select-String "ANTHROPIC_API_KEY=(.+)").Matches.Groups[1].Value
$baseUrl = ($envFile | Select-String "ANTHROPIC_BASE_URL=(.+)").Matches.Groups[1].Value
$model = ($envFile | Select-String "CLAUDE_MODEL=(.+)").Matches.Groups[1].Value
Write-Host "  -> ANTHROPIC_API_KEY: $($apiKey.Substring(0, [Math]::Min(8, $apiKey.Length)))..." -ForegroundColor DarkGray
Write-Host "  -> ANTHROPIC_BASE_URL: $baseUrl" -ForegroundColor DarkGray
Write-Host "  -> CLAUDE_MODEL: $model" -ForegroundColor DarkGray
Write-Host ""

# ---- Step 5: 部署到 Cloudflare Pages ----
Write-Host "[5/5] 部署到 Cloudflare Pages..." -ForegroundColor Yellow
Write-Host ""
& $nodePath $wranglerPath pages deploy .open-next --project-name=personal-ai-chat --branch=main 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  !! 部署失败。可能原因：" -ForegroundColor Red
    Write-Host "  1. 项目名称 'personal-ai-chat' 已被占用" -ForegroundColor Red
    Write-Host "  2. 需要先在 Cloudflare Dashboard 创建 Pages 项目" -ForegroundColor Red
    Write-Host ""
    Write-Host "  请手动操作：" -ForegroundColor Yellow
    Write-Host "  1. 打开 https://dash.cloudflare.com" -ForegroundColor Yellow
    Write-Host "  2. Workers & Pages -> Create -> Pages" -ForegroundColor Yellow
    Write-Host "  3. 上传 .open-next 文件夹" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "   部署成功！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  你的网站地址（中国可访问）：" -ForegroundColor Cyan
Write-Host "  https://personal-ai-chat.pages.dev" -ForegroundColor White
Write-Host ""
Write-Host "  重要：还需要在 Cloudflare 设置环境变量！" -ForegroundColor Red
Write-Host ""
Write-Host "  请按以下步骤操作：" -ForegroundColor Yellow
Write-Host "  1. 打开 https://dash.cloudflare.com" -ForegroundColor Yellow
Write-Host "  2. 点击左侧 Workers & Pages" -ForegroundColor Yellow
Write-Host "  3. 点击 personal-ai-chat 项目" -ForegroundColor Yellow
Write-Host "  4. 点击 Settings -> Environment variables" -ForegroundColor Yellow
Write-Host "  5. 添加以下 3 个变量（Production 环境）：" -ForegroundColor Yellow
Write-Host ""
Write-Host "     ANTHROPIC_API_KEY  =  $apiKey" -ForegroundColor White
Write-Host "     ANTHROPIC_BASE_URL =  $baseUrl" -ForegroundColor White
Write-Host "     CLAUDE_MODEL       =  $model" -ForegroundColor White
Write-Host ""
Write-Host "  6. 添加完变量后，重新运行此脚本部署一次" -ForegroundColor Yellow
Write-Host ""
