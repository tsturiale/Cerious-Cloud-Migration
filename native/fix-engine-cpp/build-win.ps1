param(
  [string]$Configuration = "RelWithDebInfo"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Project = Join-Path $Root "native\fix-engine-cpp"
$Build = Join-Path $Project "build"
$Vcpkg = Join-Path $Root ".tools\vcpkg"
$Toolchain = Join-Path $Vcpkg "scripts\buildsystems\vcpkg.cmake"
$CMake = if ($env:CMAKE_EXE) { $env:CMAKE_EXE } else { "cmake" }
$VsDevCmd = $env:VSDEVCMD_PATH

if ($VsDevCmd -and !(Test-Path -LiteralPath $VsDevCmd)) {
  throw "VSDEVCMD_PATH points to a missing file: $VsDevCmd"
}
if (!$VsDevCmd) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($installPath) {
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
if (!(Test-Path $Vcpkg)) {
  git clone https://github.com/microsoft/vcpkg.git $Vcpkg
}
if (!(Test-Path (Join-Path $Vcpkg "vcpkg.exe"))) {
  & (Join-Path $Vcpkg "bootstrap-vcpkg.bat") -disableMetrics
}
& (Join-Path $Vcpkg "vcpkg.exe") install openssl:x64-windows zstd:x64-windows

$cmdFile = Join-Path $Build "build-win.cmd"
New-Item -ItemType Directory -Force -Path $Build | Out-Null
@"
@echo off
call "$VsDevCmd" -arch=x64 -host_arch=x64
if errorlevel 1 exit /b %errorlevel%
"$CMake" -S "$Project" -B "$Build" -G Ninja -DCMAKE_BUILD_TYPE=$Configuration -DCMAKE_TOOLCHAIN_FILE="$Toolchain" -DVCPKG_TARGET_TRIPLET=x64-windows
if errorlevel 1 exit /b %errorlevel%
"$CMake" --build "$Build" --config $Configuration
exit /b %errorlevel%
"@ | Set-Content -Path $cmdFile -Encoding ASCII

cmd /c "`"$cmdFile`""
