# YullyHub — one-shot deploy script
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# What it does:
#   1. Ensures GitHub CLI is authenticated (opens browser tab)
#   2. Creates / pushes to a public GitHub repo `yullyhub-loader`
#   3. Ensures Vercel CLI is authenticated (opens browser tab)
#   4. Deploys `Web Dashboard/` to Vercel production
#   5. Prints the production URL + one-line command customers paste

$ErrorActionPreference = 'Stop'
$RepoName = 'yullyhub-loader'
$WebDashDir = Join-Path $PSScriptRoot 'Web Dashboard'

function Say ($msg, $color = 'Cyan') {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor $color
}

# ---- Refresh PATH from registry so freshly-installed CLIs are visible -----
$machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path    = "$machinePath;$userPath"

# ---- Ensure both CLIs exist -----------------------------------------------
Say "checking prerequisites..."
$ghPath     = (Get-Command gh -ErrorAction SilentlyContinue).Source
$vercelPath = (Get-Command vercel -ErrorAction SilentlyContinue).Source
# Fallback probes if PATH doesn't have them
if (-not $ghPath) {
    foreach ($p in @(
        "$env:ProgramFiles\GitHub CLI\gh.exe",
        "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe",
        "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe"
    )) { if (Test-Path $p) { $ghPath = $p; break } }
}
if (-not $vercelPath) {
    foreach ($p in @(
        "$env:APPDATA\npm\vercel.cmd",
        "$env:APPDATA\npm\vercel"
    )) { if (Test-Path $p) { $vercelPath = $p; break } }
}
if (-not $ghPath)     { throw "gh CLI not found. Install: winget install GitHub.cli" }
if (-not $vercelPath) { throw "vercel CLI not found. Install: npm i -g vercel" }
Set-Alias -Name gh     -Value $ghPath     -Scope Script
Set-Alias -Name vercel -Value $vercelPath -Scope Script
Write-Host "   gh     -> $ghPath"
Write-Host "   vercel -> $vercelPath"

# ---- Ensure git repo has the initial commit -------------------------------
Set-Location $PSScriptRoot
if (-not (Test-Path ".git")) { git init | Out-Null; git branch -M main | Out-Null }
git add . 2>&1 | Out-Null
$dirty = git status --porcelain
if ($dirty) {
    Say "committing latest changes..."
    git -c user.email="yullyhub@localhost" -c user.name="YullyHub" commit -m "deploy: sync latest build" | Out-Null
}

# ---- GitHub auth ----------------------------------------------------------
$ghStatus = (& gh auth status 2>&1 | Out-String)
if ($ghStatus -notmatch 'Logged in to github\.com') {
    Say "GITHUB authorization needed — a browser tab will open." Yellow
    Write-Host "   Copy the one-time code shown below, hit ENTER, paste it in the browser tab that opens." -ForegroundColor Yellow
    & gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) { throw "gh auth login failed." }
} else {
    Write-Host "   gh already authed."
}

# ---- Create / update the GitHub repo --------------------------------------
Say "creating GitHub repo '$RepoName' (public)..."
$owner = (gh api user --jq .login 2>$null).Trim()
if (-not $owner) { throw "couldn't read gh user." }
$exists = $false
try {
    gh repo view "$owner/$RepoName" 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $exists = $true }
} catch { $exists = $false }

if (-not $exists) {
    & gh repo create "$RepoName" --public --source=. --remote=origin --push
    if ($LASTEXITCODE -ne 0) { throw "gh repo create failed." }
} else {
    Write-Host "   repo already exists — pushing latest..."
    $remoteExists = (git remote get-url origin 2>$null)
    if (-not $remoteExists) {
        git remote add origin "https://github.com/$owner/$RepoName.git"
    }
    git push -u origin main 2>&1 | Out-Null
}

# ---- Vercel auth ----------------------------------------------------------
$vcWho = ""
try { $vcWho = (& vercel whoami 2>&1 | Select-Object -Last 1).Trim() } catch {}
if ($vcWho -match 'not authenticated' -or -not $vcWho -or $vcWho -match 'Error') {
    Say "VERCEL authorization needed — a browser tab will open." Yellow
    & vercel login
    if ($LASTEXITCODE -ne 0) { throw "vercel login failed." }
} else {
    Write-Host "   vercel logged in as $vcWho"
}

# ---- Deploy to production -------------------------------------------------
Say "deploying Web Dashboard to Vercel production..."
Set-Location $WebDashDir

# --yes accepts scoped defaults; --prod pushes to production alias
$deployOut = & vercel --prod --yes 2>&1 | Out-String
Write-Host $deployOut

# Extract the deployment URL from stdout
$prodUrl = ($deployOut -split "`n" | Where-Object { $_ -match 'https://[a-zA-Z0-9\-\.]+\.vercel\.app' } |
            ForEach-Object { ($_ | Select-String -Pattern 'https://[a-zA-Z0-9\-\.]+\.vercel\.app').Matches.Value } |
            Select-Object -Last 1)

Say "DONE" Green
if ($prodUrl) {
    Write-Host ""
    Write-Host "  Production URL:  $prodUrl" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Customer one-liner:" -ForegroundColor Cyan
    Write-Host "    irm $prodUrl/loader | iex" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host "  (couldn't parse URL from vercel output — check the log above)" -ForegroundColor Yellow
}
