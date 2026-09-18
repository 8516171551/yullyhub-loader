# yullyhub ↔ yully.wtf DB bootstrap — v3.
# Same discovery as v2, but provisions the yullyhub@% user via root.
# Set $env:MYSQL_ROOT_PW before running if root has a password:
#   $env:MYSQL_ROOT_PW = 'yourpass' ; irm https://yullyhub.com/vps-setup-v3.ps1 | iex
$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '=== YullyHub / yully.wtf shared-DB bootstrap (v3) ==='

function Find-DbBinaries {
    $svcRows = Get-CimInstance -ClassName Win32_Service -ErrorAction SilentlyContinue |
        Where-Object { $_.PathName -match 'mysqld|mariadbd' }
    foreach ($row in $svcRows) {
        $exe = ($row.PathName -replace '^"([^"]+)".*', '$1') -replace '^([^ ]+).*', '$1'
        $exe = $exe.Trim('"')
        if (Test-Path $exe) {
            $bin = Split-Path $exe -Parent
            $mysql = Join-Path $bin 'mysql.exe'
            $dump  = Join-Path $bin 'mysqldump.exe'
            if (Test-Path $mysql) {
                $ini = if ($row.PathName -match '--defaults-file=("?)([^"\s]+)') { $Matches[2] } else { $null }
                if (-not $ini -or -not (Test-Path $ini)) {
                    $ini = @(
                        Join-Path (Split-Path $bin -Parent) 'my.ini',
                        Join-Path (Split-Path $bin -Parent) 'data\my.ini'
                    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
                }
                return @{ mysql=$mysql; dump=$dump; ini=$ini; svc=$row.Name }
            }
        }
    }
    return $null
}

$db = Find-DbBinaries
if (-not $db) { throw 'MySQL service not found.' }
$mysql = $db.mysql
$dump  = $db.dump
Write-Host "service       : $($db.svc)"
Write-Host "mysql client  : $mysql"

# Try to find working root credentials
$rootPwCandidates = @()
if ($env:MYSQL_ROOT_PW) { $rootPwCandidates += $env:MYSQL_ROOT_PW }
$rootPwCandidates += @('', 'root', 'Geheim1337137', 'yully')

$rootPw = $null
foreach ($pw in $rootPwCandidates) {
    $arg = if ($pw -eq '') { @('-u','root','-e','SELECT 1;') }
           else            { @('-u','root',"-p$pw",'-e','SELECT 1;') }
    $null = & $mysql @arg 2>$null
    if ($LASTEXITCODE -eq 0) { $rootPw = $pw; break }
}

if ($null -eq $rootPw) {
    Write-Host ''
    Write-Host 'Could not connect as root with any known password.'
    Write-Host 'Set the password and re-run:'
    Write-Host '  $env:MYSQL_ROOT_PW = ''yourpass''; irm https://yullyhub.com/vps-setup-v3.ps1 | iex'
    throw 'Root auth failed.'
}
Write-Host "root auth     : ok$(if ($rootPw) { " (password set)" } else { ' (no password)' })"

function Invoke-Root([string]$sql) {
    $tempFile = [IO.Path]::GetTempFileName()
    Set-Content -Path $tempFile -Value $sql -Encoding ASCII
    try {
        if ($rootPw -eq '') { Get-Content $tempFile | & $mysql -u root }
        else                { Get-Content $tempFile | & $mysql -u root "-p$rootPw" }
    } finally {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
}

# Provision yullyhub@% with random password
$yhPass = 'YHub_' + ([guid]::NewGuid().ToString('N').Substring(0,16))
$sql = @"
CREATE USER IF NOT EXISTS 'yullyhub'@'%' IDENTIFIED BY '$yhPass';
ALTER USER 'yullyhub'@'%' IDENTIFIED BY '$yhPass';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES
    ON yully.* TO 'yullyhub'@'%';
FLUSH PRIVILEGES;
"@
Invoke-Root $sql
if ($LASTEXITCODE -ne 0) { throw 'CREATE USER failed even as root.' }
Write-Host 'yullyhub@% user provisioned.'

# Firewall (idempotent)
if (-not (Get-NetFirewallRule -DisplayName 'MySQL 3306' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'MySQL 3306' -Direction Inbound -Protocol TCP -LocalPort 3306 -Action Allow | Out-Null
    Write-Host 'Firewall rule "MySQL 3306" added.'
} else {
    Write-Host 'Firewall rule already exists.'
}

# Quick connectivity test as yullyhub
$test = & $mysql -u yullyhub "-p$yhPass" -h 127.0.0.1 yully -e 'SHOW TABLES;' 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host 'yullyhub can connect + read yully DB.'
} else {
    Write-Host "yullyhub connect test FAILED: $test"
}

Write-Host ''
Write-Host '============================================================='
Write-Host " DATABASE_URL = mysql://yullyhub:$yhPass@217.154.94.87:3306/yully"
Write-Host '============================================================='
Write-Host ''
Write-Host 'Paste that DATABASE_URL line back to Claude.'
