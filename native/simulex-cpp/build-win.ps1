param(
  [string]$Configuration = "RelWithDebInfo"
)

$ErrorActionPreference = "Stop"
$Project = $PSScriptRoot
$Build = Join-Path $Project "build"
$CMake = if ($env:CMAKE_EXE) { $env:CMAKE_EXE } else { "cmake" }
$Ninja = if ($env:NINJA_EXE) { $env:NINJA_EXE } else { "ninja" }
$VsDevCmd = $env:VSDEVCMD_PATH
$VsInstallPath = $null

if ($VsDevCmd -and !(Test-Path -LiteralPath $VsDevCmd)) {
  throw "VSDEVCMD_PATH points to a missing file: $VsDevCmd"
}
if (!$VsDevCmd) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($installPath) {
      $VsInstallPath = $installPath
      $candidate = Join-Path $installPath "Common7\Tools\VsDevCmd.bat"
      if (Test-Path -LiteralPath $candidate) {
        $VsDevCmd = $candidate
      }
    }
  }
}
if (!$VsDevCmd) {
  throw "Visual Studio C++ build environment was not found. Install Visual Studio C++ tools or set VSDEVCMD_PATH."
}
if (!$VsInstallPath) {
  $cursor = Split-Path -Parent $VsDevCmd
  while ($cursor -and !(Test-Path -LiteralPath (Join-Path $cursor "Common7\Tools\VsDevCmd.bat"))) {
    $next = Split-Path -Parent $cursor
    if ($next -eq $cursor) { break }
    $cursor = $next
  }
  if ($cursor -and (Test-Path -LiteralPath (Join-Path $cursor "Common7\Tools\VsDevCmd.bat"))) {
    $VsInstallPath = $cursor
  }
}

$vsCmake = Join-Path $VsInstallPath "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
$vsNinja = Join-Path $VsInstallPath "Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
if ($CMake -eq "cmake" -and (Test-Path -LiteralPath $vsCmake)) {
  $CMake = $vsCmake
}
if ($Ninja -eq "ninja" -and (Test-Path -LiteralPath $vsNinja)) {
  $Ninja = $vsNinja
}

New-Item -ItemType Directory -Force -Path $Build | Out-Null
$cmdFile = Join-Path $Build "build-win.cmd"
@"
@echo off
call "$VsDevCmd" -arch=x64 -host_arch=x64
if errorlevel 1 exit /b %errorlevel%
"$CMake" -S "$Project" -B "$Build" -G Ninja -DCMAKE_BUILD_TYPE=$Configuration -DCMAKE_MAKE_PROGRAM="$Ninja"
if errorlevel 1 exit /b %errorlevel%
"$CMake" --build "$Build" --config $Configuration
exit /b %errorlevel%
"@ | Set-Content -Path $cmdFile -Encoding ASCII

cmd /c "`"$cmdFile`""
