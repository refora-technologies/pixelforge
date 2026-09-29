# Walks the built installer's pages the way a user would and checks it reaches
# "Ready to Install" without the install-mode page that left v1.1.0 stuck.
#
#   powershell -ExecutionPolicy Bypass -File tools\verify-installer.ps1
#
# Stops before installing anything. Pages are identified by their text, and Next
# is pressed via the Win32 button message, because UI Automation reports NSIS
# controls inconsistently (sometimes as Text/Button, sometimes only as Pane).

param([string]$Installer = (Join-Path $PSScriptRoot '..\dist\PixelForge-Setup.exe'))

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Name Win32 -Namespace PF -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hDlg, int id);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
'@

if (-not (Test-Path $Installer)) { Write-Output "Installer not found: $Installer - run npm run build first."; exit 1 }

$BM_CLICK = 0x00F5
$NEXT_BUTTON_ID = 1   # NSIS: Next / I Agree / Install
$headings = 'License Agreement', 'Choose Installation Options', 'Choose Install Location', 'Ready to Install', 'Installing'
$root = [System.Windows.Automation.AutomationElement]::RootElement
$proc = Start-Process -FilePath $Installer -PassThru
Start-Sleep -Seconds 4

$pages = @()
$target = ''
try {
  for ($i = 1; $i -le 10; $i++) {
    $proc.Refresh()
    if ($proc.HasExited) { break }
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
    $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if (-not $win) { Start-Sleep -Seconds 1; continue }

    $texts = @()
    foreach ($el in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { $texts += $el.Current.Name }
    $heading = $headings | Where-Object { $h = $_; $texts | Where-Object { $_ -like "$h*" } } | Select-Object -First 1
    if ($heading -and ($pages.Count -eq 0 -or $pages[-1] -ne $heading)) { $pages += $heading; Write-Output "page: $heading" }

    if ($heading -eq 'Ready to Install') {
      $target = $texts | Where-Object { $_ -like '*\PixelForge*' } | Select-Object -First 1
      break
    }
    if ($heading -eq 'Choose Installation Options') { break }

    $next = [PF.Win32]::GetDlgItem([IntPtr]$win.Current.NativeWindowHandle, $NEXT_BUTTON_ID)
    if ($next -ne [IntPtr]::Zero -and [PF.Win32]::IsWindowEnabled($next)) {
      [void][PF.Win32]::PostMessage($next, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
    }
    Start-Sleep -Seconds 3
  }
} finally {
  if (-not $proc.HasExited) { $proc.Kill() }
}

if ($target) { Write-Output ("installs to: " + $target.Trim()) }
if ($pages -contains 'Choose Installation Options') { Write-Output 'RESULT: FAIL - the install-mode page is back'; exit 1 }
if ($pages.Count -gt 0 -and $pages[-1] -eq 'Ready to Install') { Write-Output ('RESULT: PASS - ' + ($pages -join ' -> ')); exit 0 }
Write-Output ('RESULT: INCONCLUSIVE - saw: ' + ($pages -join ' -> '))
exit 2
