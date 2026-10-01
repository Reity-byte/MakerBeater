# MakerBeater – vytvoří zástupce, které otevřou aplikaci v samostatném okně
# (režim aplikace Chrome/Edge: bez adresního řádku a záložek, přes celou obrazovku).
#
# Spouští se přes „Nainstalovat aplikaci.cmd“ v hlavní složce projektu.
# Po přesunutí složky projektu stačí spustit znovu – zástupci se přepíšou.

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot            # hlavní složka projektu
$index = Join-Path $appDir 'index.html'
$icon = Join-Path $PSScriptRoot 'icon.ico'
if (-not (Test-Path -LiteralPath $index)) { throw "Ve složce $appDir chybí index.html." }

# Prohlížeč, který umí režim aplikace (--app): Chrome, jinak Edge (ten je ve Windows vždy)
$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $browser) { throw 'Nenašel jsem Google Chrome ani Microsoft Edge.' }

# file:///C:/... se správně zakódovanou diakritikou a mezerami
$url = ([System.Uri]$index).AbsoluteUri

# Vlastní profil prohlížeče: aplikace má samostatné okno i ikonu na liště,
# vždy se otevře přes celou obrazovku a její uložené projekty se nemíchají s běžným prohlížením.
$profileDir = Join-Path $env:LOCALAPPDATA 'MakerBeater'
$arguments = "--app=`"$url`" --user-data-dir=`"$profileDir`" --no-first-run --no-default-browser-check --start-maximized"

$shell = New-Object -ComObject WScript.Shell
$shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MakerBeater.lnk'),   # plocha
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'MakerBeater.lnk'),  # nabídka Start (jde vyhledat)
  (Join-Path $appDir 'MakerBeater.lnk')                                      # složka projektu
)

Write-Host ''
Write-Host 'MakerBeater – instalace zástupců' -ForegroundColor Cyan
Write-Host "  prohlížeč: $browser"
foreach ($path in $shortcuts) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $browser
  $lnk.Arguments = $arguments
  $lnk.WorkingDirectory = $appDir
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = 'MakerBeater – piano roll a step sequencer'
  $lnk.Save()
  Write-Host "  zástupce:  $path"
}
Write-Host ''
Write-Host 'Hotovo. Aplikaci spustíš ikonou MakerBeater na ploše nebo v nabídce Start.' -ForegroundColor Green
