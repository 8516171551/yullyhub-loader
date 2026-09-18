# yullyhub ↔ yully.wtf DB bootstrap.
# Run once on the VPS via:  irm https://yullyhub.com/vps-setup.ps1 | iex
$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '=== YullyHub / yully.wtf shared-DB bootstrap ==='

# 1) Locate MySQL / MariaDB by inspecting the running service — this
#    catches whatever exotic path the DB was installed at, instead of
#    us guessing among a dozen default install locations.
function Find-DbBinaries {
    # Look at any service whose ImagePath contains mysqld/mariadbd
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
                # my.ini often lives at ..\data\my.ini next to the bin dir,
                # or wherever `mysqld --defaults-file=` points to.
                $ini = if ($row.PathName -match '--defaults-file=("?)([^"\s]+)') { $Matches[2] } else { $null }
                if (-not $ini -or -not (Test-Path $ini)) {
                    $ini = @(
                        Join-Path (Split-Path $bin -Parent) 'data\my.ini',
                        Join-Path (Split-Path $bin -Parent) 'my.ini'
                    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
                }
                return @{ mysql=$mysql; dump=$dump; ini=$ini; svc=$row.Name }
            }
        }
    }
    # Fallback: filesystem scan under Program Files / ProgramData
    $roots = @('C:\Program Files','C:\Program Files (x86)','C:\ProgramData') |
             Where-Object { Test-Path $_ }
    foreach ($r in $roots) {
        $hit = Get-ChildItem -Path $r -Filter mysql.exe -Recurse -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if ($hit) {
            $bin  = $hit.DirectoryName
            $ini  = @(
                Join-Path (Split-Path $bin -Parent) 'data\my.ini',
                Join-Path (Split-Path $bin -Parent) 'my.ini'
            ) | Where-Object { Test-Path $_ } | Select-Object -First 1
            return @{ mysql=$hit.FullName; dump=Join-Path $bin 'mysqldump.exe'; ini=$ini; svc=$null }
        }
    }
    return $null
}

$db = Find-DbBinaries
if (-not $db) {
    Write-Host ''
    Write-Host 'MySQL/MariaDB not found in Services or under Program Files.'
    Write-Host 'Paste the output of these two commands so I can locate it:'
    Write-Host '  Get-CimInstance Win32_Service | ? { $_.PathName -match "mysqld|mariadbd" } | Select Name, PathName'
    Write-Host '  Get-ChildItem C:\ -Filter mysql.exe -Recurse -ErrorAction SilentlyContinue | Select FullName'
    throw 'Cannot proceed without the mysql client.'
}

$myini = $db.ini
$mysql = $db.mysql
$dump  = $db.dump
Write-Host "service       : $($db.svc)"
Write-Host "my.ini        : $myini"
Write-Host "mysql client  : $mysql"
Write-Host "mysqldump     : $dump"

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
