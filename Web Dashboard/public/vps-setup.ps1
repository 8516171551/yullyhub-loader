# yullyhub ↔ yully.wtf DB bootstrap.
# Run once on the VPS via:  irm https://yullyhub.com/vps-setup.ps1 | iex
$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '=== YullyHub / yully.wtf shared-DB bootstrap ==='

# 1) Locate MySQL / MariaDB config + client on this box
$myini = @(
  'C:\ProgramData\MariaDB\MariaDB Server 11\my.ini',
  'C:\ProgramData\MariaDB\MariaDB Server 10.11\my.ini',
  'C:\ProgramData\MariaDB\MariaDB Server 10.6\my.ini',
  'C:\Program Files\MariaDB 11\data\my.ini',
  'C:\Program Files\MariaDB 10.11\data\my.ini',
  'C:\ProgramData\MySQL\MySQL Server 8.0\my.ini',
  'C:\Program Files\MySQL\MySQL Server 8.0\my.ini'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$mysql = @(
  'C:\Program Files\MariaDB 11\bin\mysql.exe',
  'C:\Program Files\MariaDB 10.11\bin\mysql.exe',
  'C:\Program Files\MariaDB 10.6\bin\mysql.exe',
  'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$dump = @(
  'C:\Program Files\MariaDB 11\bin\mysqldump.exe',
  'C:\Program Files\MariaDB 10.11\bin\mysqldump.exe',
  'C:\Program Files\MariaDB 10.6\bin\mysqldump.exe',
  'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

Write-Host "my.ini        : $myini"
Write-Host "mysql client  : $mysql"
Write-Host "mysqldump     : $dump"
if (-not $mysql) { throw 'MySQL/MariaDB client not found. Aborting.' }

# 2) Bind MySQL/MariaDB to all interfaces so Vercel can connect
if ($myini) {
    Copy-Item $myini "$myini.bak-$(Get-Date -Format yyyyMMddHHmmss)" -Force
    $text = Get-Content $myini -Raw
    if ($text -match '(?ms)^\s*bind[-_]address\s*=.*') {
        $text = [regex]::Replace($text, '(?m)^\s*bind[-_]address\s*=.*', 'bind-address = 0.0.0.0')
    } else {
        $text = $text -replace '(?m)^\[mysqld\]\s*$', "[mysqld]`r`nbind-address = 0.0.0.0"
    }
    Set-Content $myini $text -Encoding ASCII
    Write-Host 'my.ini bind-address = 0.0.0.0'
}

# 3) Restart the service
$svc = Get-Service -Name 'MariaDB','MySQL','MySQL80' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($svc) {
    Restart-Service -Name $svc.Name -Force
    Write-Host "Restarted $($svc.Name)"
}

# 4) Firewall: open 3306
if (-not (Get-NetFirewallRule -DisplayName 'MySQL 3306' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'MySQL 3306' -Direction Inbound -Protocol TCP -LocalPort 3306 -Action Allow | Out-Null
    Write-Host 'Firewall rule "MySQL 3306" added.'
}

# 5) Create yullyhub user with a random password
$yhPass = 'YHub_' + ([guid]::NewGuid().ToString('N').Substring(0,16))
$sql = @"
CREATE USER IF NOT EXISTS 'yullyhub'@'%' IDENTIFIED BY '$yhPass';
ALTER USER 'yullyhub'@'%' IDENTIFIED BY '$yhPass';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES
    ON yully.* TO 'yullyhub'@'%';
FLUSH PRIVILEGES;
"@
$sql | & $mysql -u yully -pyully yully
Write-Host 'yullyhub@% user provisioned.'

# 6) Dump schema for Claude to reference
if ($dump) {
    & $dump -u yully -pyully --no-data --skip-comments --skip-add-drop-table yully > C:\yully-schema.sql
    Write-Host 'Schema written to C:\yully-schema.sql'
}

# 7) Table + row counts snapshot
$snap = & $mysql -u yully -pyully yully -e "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA='yully' ORDER BY TABLE_NAME;"
Write-Host ''
Write-Host '=== Tables ==='
$snap

Write-Host ''
Write-Host '============================================================='
Write-Host " DATABASE_URL = mysql://yullyhub:$yhPass@217.154.94.87:3306/yully"
Write-Host '============================================================='
Write-Host ''
Write-Host 'Paste that DATABASE_URL line + the contents of C:\yully-schema.sql'
Write-Host 'back to Claude and it will wire everything up.'
