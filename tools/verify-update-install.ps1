# Real one-click update, end to end: installs an older PixelForge, starts it,
# runs the new installer exactly the way "Restart to update" does, and checks
# the new version is installed and running again. Uninstalls afterwards.
#
#   powershell -ExecutionPolicy Bypass -File tools\verify-update-install.ps1 -Old <older PixelForge-Setup.exe>
#
# Refuses to run if PixelForge is already installed, so it never touches a
# real installation. Settings in %APPDATA%\PixelForge are left as they are.

param(
  [Parameter(Mandatory = $true)][string]$Old,
  [string]$New = ''
)

if (-not $New) { $New = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\dist\PixelForge-Setup.exe' }
$ErrorActionPreference = 'Stop'
# Must match SILENT_UPDATE_ARGS in src/main/updater.js.
$UpdateArgs = '/S --updated --force-run'
$Dir = Join-Path $env:LOCALAPPDATA 'Programs\PixelForge'
$Exe = Join-Path $Dir 'PixelForge.exe'
$failures = 0

function Check($name, $ok, $detail) {
  if ($ok) { Write-Output "  PASS  $name" } else { Write-Output "  FAIL  $name $(if ($detail) { '- ' + $detail })"; $script:failures++ }
}
function Entry {
  foreach ($root in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall') {
    foreach ($k in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
      $name = $null; $ver = $null
      try { $name = $k.GetValue('DisplayName'); $ver = $k.GetValue('DisplayVersion') } catch {}
      if ($name -like 'PixelForge*') { return [pscustomobject]@{ Key = $k.PSPath; Version = $ver } }
    }
  }
  return $null
}
function Running { @(Get-Process PixelForge -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$Dir\*" }) }
function WaitFor([scriptblock]$cond, [int]$seconds) {
  $t = [DateTime]::Now.AddSeconds($seconds)
  while ([DateTime]::Now -lt $t) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  return [bool](& $cond)
}
# '1.2.0.0' and '1.2.0' are the same version.
function Version($file) { ((Get-Item $file).VersionInfo.ProductVersion -split '\.')[0..2] -join '.' }

foreach ($f in $Old, $New) { if (-not (Test-Path $f)) { Write-Output "Not found: $f"; exit 1 } }
if (Entry) { Write-Output 'PixelForge is already installed on this PC - uninstall it first. Nothing was changed.'; exit 1 }
if (Running) { Write-Output 'PixelForge is running - close it first. Nothing was changed.'; exit 1 }

$oldVersion = Version $Old
$newVersion = Version $New
Write-Output "update $oldVersion -> $newVersion"

try {
  Write-Output "`ninstall the older version"
  Start-Process -FilePath $Old -ArgumentList '/S' -Wait
  Check 'installed' (Test-Path $Exe)
  Check "is $oldVersion" ((Version $Exe) -eq $oldVersion) (Version $Exe)

  # Builds before 1.2.0 obey ELECTRON_RUN_AS_NODE, which some terminals set, and
  # quietly exit as plain Node. Start the old one without it.
  $env:ELECTRON_RUN_AS_NODE = $null
  Start-Process -FilePath $Exe
  Check 'running' (WaitFor { (Running | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0 } 60)
  $before = Running | ForEach-Object { $_.Id }

  Write-Output "`nupdate as Restart to update does (app still open)"
  $started = Get-Date
  $inst = Start-Process -FilePath $New -ArgumentList $UpdateArgs -PassThru
  Check 'installer finishes' (WaitFor { $inst.HasExited } 240)
  Check 'installer succeeded' ($inst.ExitCode -eq 0) "exit code $($inst.ExitCode)"
  Check 'the old copy was closed' ($before.Count -gt 0 -and -not (Running | Where-Object { $before -contains $_.Id }))
  $installed = Version $Exe
  Check "files are $newVersion" ($installed -eq $newVersion) $installed
  $e = Entry
  Check "Apps list shows $newVersion" ($e -and $e.Version -eq $newVersion) $(if ($e) { $e.Version })
  Check 'PixelForge opens again by itself' (WaitFor { (Running | Where-Object { $_.StartTime -gt $started -and $_.MainWindowHandle -ne 0 }).Count -gt 0 } 60)
  $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\PixelForge.lnk'
  Check 'Start menu shortcut kept' (Test-Path $lnk)

  Write-Output "`nhardening"
  Running | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $env:ELECTRON_RUN_AS_NODE = '1'
  Start-Process -FilePath $Exe
  $env:ELECTRON_RUN_AS_NODE = $null
  Check 'opens even with ELECTRON_RUN_AS_NODE set' (WaitFor { (Running | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0 } 60)
} finally {
  Write-Output "`nclean up"
  Running | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $uninstaller = Join-Path $Dir 'Uninstall PixelForge.exe'
  if (Test-Path $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait }
  # The uninstaller hands off to a copy of itself, so -Wait returns early.
  $gone = WaitFor { -not (Entry) -and -not (Test-Path $Exe) } 90
  Check 'uninstalled' $gone
  foreach ($s in (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\PixelForge.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'PixelForge.lnk')) {
    Check "removed $(Split-Path $s -Leaf) from $(Split-Path (Split-Path $s) -Leaf)" (-not (Test-Path $s))
  }
}

if ($failures) { Write-Output "`nRESULT: FAIL ($failures)"; exit 1 }
Write-Output "`nRESULT: PASS"
