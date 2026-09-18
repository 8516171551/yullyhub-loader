# yully.wtf VPS deploy — pulls latest from GitHub, installs deps, restarts pm2.
# Run on the VPS (RDP as Administrator, PowerShell):
#   irm https://yullyhub.com/deploy-website.ps1 | iex
#
# Idempotent. First run bootstraps everything; subsequent runs are a fast pull+restart.

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '=== yully.wtf VPS deploy ==='

# ---- Config --------------------------------------------------------
$RepoUrl   = 'https://github.com/8516171551/yully-website.git'
$AppDir    = 'C:\yully-website'
$AppPort   = 3001
$AppName   = 'yully-website'
$NodeMin   = 20
# --------------------------------------------------------------------

function Test-CommandExists($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# 1) Node.js
if (-not (Test-CommandExists node)) {
    throw @'
Node.js not installed. Install LTS first:
    winget install OpenJS.NodeJS.LTS
or download from https://nodejs.org/en/download and re-run.
'@
}
$nodeVer = (node -v).TrimStart('v').Split('.')[0]
if ([int]$nodeVer -lt $NodeMin) {
    throw "Node $nodeVer is too old. Need >= $NodeMin. Run: winget upgrade OpenJS.NodeJS.LTS"
}
Write-Host "node.js       : v$(node -v)"

# 2) pm2 (process manager — runs Next.js as a Windows service that survives reboots)
if (-not (Test-CommandExists pm2)) {
    Write-Host 'Installing pm2 globally...'
    npm install -g pm2 --silent 2>$null
    npm install -g pm2-windows-startup --silent 2>$null
    pm2-startup install 2>$null | Out-Null
}
Write-Host "pm2           : $((pm2 -v).Trim())"

# 3) git (auto-install via winget if missing)
if (-not (Test-CommandExists git)) {
    Write-Host 'git not installed — installing via winget...'
    winget install --id Git.Git -e --source winget --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
    # winget doesn't refresh PATH for the current session — reload it.
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Test-CommandExists git)) {
        throw 'git install failed. Install manually: winget install Git.Git   then reopen PowerShell and re-run.'
    }
}
Write-Host "git           : $(((git --version) -split ' ')[-1])"

# 4) Clone or pull
if (-not (Test-Path $AppDir)) {
    Write-Host "Cloning $RepoUrl → $AppDir"
    git clone $RepoUrl $AppDir 2>&1 | Out-Host
} else {
    Write-Host "Pulling latest into $AppDir"
    Push-Location $AppDir
    git fetch origin 2>&1 | Out-Host
    git reset --hard origin/master 2>&1 | Out-Host
    Pop-Location
}

# 5) Ensure .env exists — merge in only the keys the new unified schema needs.
#    Preserves whatever secrets are already on the VPS from before the migration
#    (Discord/Stripe/Resend/Admin/DB legacy vars). This script never bakes
#    secrets into itself — the ps1 is publicly downloadable.
$envPath = Join-Path $AppDir '.env'
$existing = @{}
if (Test-Path $envPath) {
    Get-Content $envPath | ForEach-Object {
        if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
            $existing[$Matches[1]] = $Matches[2]
        }
    }
}
# Defaults we WILL set (safe, non-secret, unified-schema requirements).
$defaults = @{
    'PORT'                 = '3001'
    'NODE_ENV'             = 'production'
    'SITE_URL'             = 'https://yully.wtf'
    'NEXT_PUBLIC_BASE_URL' = 'https://yully.wtf'
    'DATABASE_URL'         = 'mysql://yully:yully@localhost:3306/yully'
    'RESEND_FROM'          = 'no-reply@fbo.foundation'
    'DB_HOST'              = '127.0.0.1'
    'DB_PORT'              = '3306'
    'DB_USER'              = 'yully'
    'DB_PASS'              = 'yully'
    'DB_NAME'              = 'yully'
    'ALLOWED_HOSTS'        = 'yully.wtf,www.yully.wtf,localhost,127.0.0.1,217.154.94.87'
    'UPLOADS_DIR'          = 'C:\ProgramData\yully-uploads'
    'PAYLOADS_DIR'         = 'C:\ProgramData\yully-payloads'
    'KEY_DIR'              = 'C:\ProgramData\yully-keys'
}
foreach ($k in $defaults.Keys) {
    if (-not $existing.ContainsKey($k) -or -not $existing[$k]) {
        $existing[$k] = $defaults[$k]
    }
}
# SESSION_SECRET — must exist. If missing, generate a fresh one.
if (-not $existing.ContainsKey('SESSION_SECRET') -or -not $existing['SESSION_SECRET']) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $existing['SESSION_SECRET'] = -join ($bytes | ForEach-Object { $_.ToString('x2') })
}
# Warn (don't set) if secrets from the old .env are missing. VPS admin must add via RDP.
$requiredSecrets = @('RESEND_API_KEY','ADMIN_PASS','DISCORD_BOT_TOKEN','STRIPE_SECRET_KEY')
foreach ($k in $requiredSecrets) {
    if (-not $existing.ContainsKey($k) -or -not $existing[$k]) {
        Write-Host "WARN: .env is missing $k. Paste it in $envPath manually."
    }
}
$lines = $existing.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" }
Set-Content -Path $envPath -Value $lines -Encoding ASCII
Write-Host ".env          : merged ($envPath, $($existing.Count) keys)"

# 6) Install deps + build
Push-Location $AppDir
Write-Host 'Installing dependencies...'
npm install --silent --no-audit --no-fund 2>&1 | Select-Object -Last 3 | Out-Host

Write-Host 'Building Next.js...'
$env:NODE_ENV = 'production'
npm run build 2>&1 | Select-Object -Last 20 | Out-Host

# 7) Start / reload via pm2
$isRunning = (pm2 list 2>$null | Out-String) -match [regex]::Escape($AppName)
if ($isRunning) {
    Write-Host "Reloading $AppName ..."
    pm2 reload $AppName --update-env 2>&1 | Out-Host
} else {
    Write-Host "Starting $AppName ..."
    pm2 start npm --name $AppName -- run start 2>&1 | Out-Host
}
pm2 save 2>&1 | Out-Null
Pop-Location

# 8) Firewall
if (-not (Get-NetFirewallRule -DisplayName "yully-website $AppPort" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "yully-website $AppPort" -Direction Inbound -Protocol TCP -LocalPort $AppPort -Action Allow | Out-Null
    Write-Host "firewall      : opened port $AppPort"
}

# 9) Health check
Start-Sleep -Seconds 3
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$AppPort/" -UseBasicParsing -TimeoutSec 5
    Write-Host "health        : HTTP $($r.StatusCode) on :$AppPort"
} catch {
    Write-Host "health        : FAILED — check 'pm2 logs $AppName'"
}

Write-Host ''
Write-Host '============================================================='
Write-Host " yully.wtf deployed. Reverse proxy → http://127.0.0.1:$AppPort"
Write-Host " Watch logs:  pm2 logs $AppName"
Write-Host " Restart:     pm2 restart $AppName"
Write-Host " Redeploy:    irm https://yullyhub.com/deploy-website.ps1 | iex"
Write-Host '============================================================='
