param(
  [switch]$DesktopClient
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$TerminalDir = Join-Path $Root "apps\terminal"
$BackendOut = Join-Path $Root "cerious-backend.out.log"
$BackendErr = Join-Path $Root "cerious-backend.err.log"
$FrontendOut = Join-Path $Root "cerious-frontend.out.log"
$FrontendErr = Join-Path $Root "cerious-frontend.err.log"
$LauncherLog = Join-Path $Root "cerious-launcher.log"
$BackendHost = if ($env:CERIOUS_BACKEND_HOST) { $env:CERIOUS_BACKEND_HOST } else { "127.0.0.1" }
$BackendPort = if ($env:CERIOUS_BACKEND_PORT) { [int]$env:CERIOUS_BACKEND_PORT } else { 8000 }
$FrontendHost = if ($env:CERIOUS_FRONTEND_HOST) { $env:CERIOUS_FRONTEND_HOST } else { "127.0.0.1" }
$FrontendPort = if ($env:CERIOUS_FRONTEND_PORT) { [int]$env:CERIOUS_FRONTEND_PORT } else { 5173 }
$BackendUrl = "http://$($BackendHost):$($BackendPort)"
$FrontendDevUrl = "http://$($FrontendHost):$($FrontendPort)"
$RequiredContractVersion = 10

function Write-LauncherLog {
  param([string]$Message)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $LauncherLog -Value "[$stamp] $Message"
}

function Import-DotEnv {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (!$line -or $line.StartsWith("#") -or !$line.Contains("=")) { return }
    $parts = $line -split "=", 2
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($name) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

function Test-LocalPort {
  param(
    [string]$HostName,
    [int]$Port
  )
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $attempt = $client.BeginConnect($HostName, $Port, $null, $null)
    if (!$attempt.AsyncWaitHandle.WaitOne(250, $false)) { return $false }
    $client.EndConnect($attempt)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Invoke-Json {
  param(
    [string]$Uri,
    [string]$Method = "GET",
    [int]$TimeoutSec = 8
  )
  try {
    return Invoke-RestMethod -Uri $Uri -Method $Method -TimeoutSec $TimeoutSec
  } catch {
    return $null
  }
}

function Test-BackendHealth {
  $payload = Invoke-Json -Uri "$BackendUrl/api/health" -TimeoutSec 4
  return ($payload -and $payload.ok -eq $true -and $payload.app -eq "cerious-systems")
}

function Test-BackendContract {
  $payload = Invoke-Json -Uri "$BackendUrl/api/system/contract" -TimeoutSec 4
  return ($payload -and $payload.app -eq "cerious-systems" -and [int]$payload.contractVersion -ge $RequiredContractVersion)
}

function Test-BackendOwnedByThisRoot {
  $proc = Get-PortProcess -Port $BackendPort
  if (!$proc) { return $false }
  $cmd = [string]$proc.CommandLine
  return ($cmd -and $cmd.Contains($Root))
}

function Wait-BackendHealth {
  param([int]$Seconds = 60)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Test-BackendHealth) -and (Test-BackendContract) -and (Test-BackendOwnedByThisRoot)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Wait-HttpOk {
  param([string]$Uri, [int]$Seconds = 45)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 4
      if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300) { return $true }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

function Get-PortProcess {
  param([int]$Port)
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$conn) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
}

function Stop-StaleCeriousPortProcess {
  param([int]$Port)
  $proc = Get-PortProcess -Port $Port
  if (!$proc) { return $false }
  $cmd = [string]$proc.CommandLine
  $isCeriousBackend = Test-BackendHealth
  if (($cmd -and $cmd.Contains($Root)) -or $isCeriousBackend) {
    Write-LauncherLog "Stopping stale Cerious process pid=$($proc.ProcessId) on port $Port"
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    Start-Sleep -Seconds 1
    return $true
  }
  Write-LauncherLog "Port $Port is occupied by non-Cerious process pid=$($proc.ProcessId); command=$cmd"
  return $false
}

function Find-Npm {
  $candidates = @(
    (Join-Path $Root ".tools\node-v26.3.0-win-x64\npm.cmd"),
    (Join-Path $env:ProgramFiles "nodejs\npm.cmd")
  )
  $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($cmd) { $candidates = @($cmd.Source) + $candidates }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  throw "npm.cmd was not found. Production launch does not require npm; set CERIOUS_DEV_FRONTEND=0 or restore Node for dev mode."
}

function Start-Backend {
  $python = Join-Path $Root ".venv\Scripts\python.exe"
  if (!(Test-Path -LiteralPath $python)) {
    throw "Python venv not found at $python"
  }

  if ((Test-BackendHealth) -and (Test-BackendContract)) {
    if (Test-BackendOwnedByThisRoot) {
      Write-LauncherLog "Backend health and contract OK on $BackendUrl"
      return
    }
    Write-LauncherLog "Cerious backend is healthy but running from another root; restarting from $Root"
    if (!(Stop-StaleCeriousPortProcess -Port $BackendPort)) {
      throw "Port $BackendPort is a Cerious backend from another root but could not be stopped."
    }
  }

  if (Test-LocalPort -HostName $BackendHost -Port $BackendPort) {
    if (!(Stop-StaleCeriousPortProcess -Port $BackendPort)) {
      throw "Port $BackendPort is listening but is not the Cerious backend. Cannot launch deterministically."
    }
  }

  Write-LauncherLog "Starting backend on $BackendHost`:$BackendPort"
  Start-Process `
    -FilePath $python `
    -ArgumentList @("-m", "uvicorn", "services.gateway.main:app", "--host", $BackendHost, "--port", "$BackendPort") `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $BackendOut `
    -RedirectStandardError $BackendErr

  if (!(Wait-BackendHealth -Seconds 75)) {
    throw "Backend did not pass /api/health within startup window."
  }
  Write-LauncherLog "Backend health and contract OK on $BackendUrl"
}

function Start-FrontendDevIfRequested {
  if ($env:CERIOUS_DEV_FRONTEND -ne "1") { return $false }
  $npm = Find-Npm
  $nodeDir = Split-Path -Parent $npm
  $env:PATH = "$nodeDir;$env:PATH"
  if (!(Test-LocalPort -HostName $FrontendHost -Port $FrontendPort)) {
    Write-LauncherLog "Starting frontend dev server on $FrontendHost`:$FrontendPort"
    Start-Process `
      -FilePath $npm `
      -ArgumentList @("run", "dev", "--", "--host", $FrontendHost, "--port", "$FrontendPort") `
      -WorkingDirectory $TerminalDir `
      -WindowStyle Hidden `
      -RedirectStandardOutput $FrontendOut `
      -RedirectStandardError $FrontendErr
  } else {
    Write-LauncherLog "Frontend dev server already listening on $FrontendDevUrl"
  }
  if (!(Wait-HttpOk -Uri $FrontendDevUrl -Seconds 45)) {
    throw "Frontend dev server did not serve HTTP within startup window."
  }
  return $true
}

function Invoke-SystemWarmup {
  Write-LauncherLog "Warming data, studies, alerts, and workspace intelligence"
  $payload = Invoke-Json -Uri "$BackendUrl/api/system/warmup?blocking=true&timeout=180" -Method "POST" -TimeoutSec 190
  if (!$payload) {
    Write-LauncherLog "WARN: warmup endpoint did not return; app will open but algo deployment will fail closed if studies are stale"
    return
  }
  $studyOk = $payload.studies.ok
  $status = $payload.status
  $warmupMs = $payload.warmupMs
  Write-LauncherLog "Warmup status=$status studiesOk=$studyOk warmupMs=$warmupMs"
}

function Open-Terminal {
  param([string]$BaseUrl)
  $launchId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($DesktopClient) {
    Write-LauncherLog "DesktopClient flag received; native desktop workflow is not launched by the web/canvas starter."
  }
  $url = "$BaseUrl/?cerious_launch=$launchId&cerious_view=canvas"
  Start-Process $url
}

$mutex = New-Object System.Threading.Mutex($false, "Global\CeriousSystemsTerminalLauncher")
$hasLauncherLock = $false

try {
  $hasLauncherLock = $mutex.WaitOne(0)
  Import-DotEnv -Path (Join-Path $Root ".env")

  if (!$hasLauncherLock) {
    Write-LauncherLog "Another launcher is starting services; waiting for backend readiness"
    if (!(Wait-BackendHealth -Seconds 75)) {
      throw "Existing launch did not produce a healthy backend."
    }
    $devMode = Start-FrontendDevIfRequested
    Invoke-SystemWarmup
    $openUrl = $BackendUrl
    if ($devMode) { $openUrl = $FrontendDevUrl }
    Open-Terminal -BaseUrl $openUrl
    return
  }

  Write-LauncherLog "Launch requested from $Root"
  Start-Backend
  $devMode = Start-FrontendDevIfRequested
  if (!$devMode -and !(Wait-HttpOk -Uri $BackendUrl -Seconds 30)) {
    throw "Backend did not serve terminal UI from production build."
  }
  $frontendMode = "backend-static"
  $openUrl = $BackendUrl
  if ($devMode) {
    $frontendMode = "dev"
    $openUrl = $FrontendDevUrl
  }
  Invoke-SystemWarmup
  Write-LauncherLog "Ready status backend=True frontend=$frontendMode"
  Open-Terminal -BaseUrl $openUrl
} catch {
  Write-LauncherLog "ERROR: $($_.Exception.Message)"
  throw
} finally {
  if ($hasLauncherLock) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
