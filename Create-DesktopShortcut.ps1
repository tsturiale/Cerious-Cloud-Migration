param(
  [switch]$Taskbar
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ShortcutName = "Cerious Systems.lnk"
$TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$LauncherScript = Join-Path $Root "Launch-Cerious.vbs"
$IconCandidates = @(
  (Join-Path $Root "assets\branding\cerious-logo.ico"),
  (Join-Path $Root "apps\terminal\public\branding\cerious-logo.ico"),
  (Join-Path $Root "cerious.ico")
)
$IconPath = $IconCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

function Remove-CeriousShortcut {
  param([string]$Folder)
  if (!(Test-Path -LiteralPath $Folder)) { return }
  $shell = New-Object -ComObject WScript.Shell
  Get-ChildItem -LiteralPath $Folder -Filter "*.lnk" -ErrorAction SilentlyContinue |
    Where-Object {
      if ($_.Name -match "Cerious") { return $true }
      try {
        $shortcut = $shell.CreateShortcut($_.FullName)
        $text = @(
          [string]$shortcut.TargetPath,
          [string]$shortcut.Arguments,
          [string]$shortcut.WorkingDirectory,
          [string]$shortcut.IconLocation
        ) -join " "
        return ($text -and $text.Contains($Root))
      } catch {
        return $false
      }
    } |
    ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
}

function New-CeriousShortcut {
  param([string]$Path)
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $TargetPath
  $shortcut.Arguments = "`"$LauncherScript`""
  $shortcut.WorkingDirectory = $Root
  $shortcut.Description = "Launch Cerious Systems Terminal"
  $shortcut.WindowStyle = 7
  if ($IconPath) {
    $shortcut.IconLocation = "$IconPath,0"
  }
  $shortcut.Save()
}

$desktop = [Environment]::GetFolderPath("Desktop")
$programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$chromeApps = Join-Path $programs "Chrome Apps"
$edgeApps = Join-Path $programs "Microsoft Edge Apps"
$taskbarPins = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"

Remove-CeriousShortcut -Folder $desktop
Remove-CeriousShortcut -Folder $programs
Remove-CeriousShortcut -Folder $chromeApps
Remove-CeriousShortcut -Folder $edgeApps
Remove-CeriousShortcut -Folder $taskbarPins

$desktopShortcut = Join-Path $desktop $ShortcutName
$startMenuShortcut = Join-Path $programs $ShortcutName

New-CeriousShortcut -Path $desktopShortcut
New-CeriousShortcut -Path $startMenuShortcut

if ($Taskbar) {
  New-Item -ItemType Directory -Force -Path $taskbarPins | Out-Null
  New-CeriousShortcut -Path (Join-Path $taskbarPins $ShortcutName)
}

Write-Host "Created Desktop shortcut: $desktopShortcut"
Write-Host "Created Start Menu shortcut: $startMenuShortcut"
if ($Taskbar) {
  Write-Host "Created Taskbar pinned-folder shortcut. Windows may require Explorer restart or manual pin refresh to show it."
}
Write-Host "Icon: $IconPath"
