@echo off
:: ╔══════════════════════════════════════════════════════════════╗
:: ║            CERIOUS SYSTEMS TRADING TERMINAL                 ║
:: ║                  Desktop Launcher                           ║
:: ╚══════════════════════════════════════════════════════════════╝
::
:: Double-click to launch the full platform. No IDE required.
:: Starts: Backend Gateway (:8000) + Frontend Dev Server (:5173)
:: Opens:  http://127.0.0.1:5173 in your default browser

title Cerious Systems — Launcher
color 0A

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "TERMINAL_DIR=%ROOT%\apps\terminal"
set "BACKEND_HOST=127.0.0.1"
set "BACKEND_PORT=8000"
set "FRONTEND_HOST=127.0.0.1"
set "FRONTEND_PORT=5173"
set "PATH=C:\Program Files\nodejs;%PATH%"

:: ── Load .env if present ──────────────────────────────────────
if exist "%ROOT%\.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%ROOT%\.env") do (
    set "%%A=%%B" 2>nul
  )
)

echo.
echo   ╔══════════════════════════════════════════╗
echo   ║     CERIOUS SYSTEMS TRADING TERMINAL     ║
echo   ╠══════════════════════════════════════════╣
echo   ║  Backend:   http://%BACKEND_HOST%:%BACKEND_PORT%      ║
echo   ║  Frontend:  http://%FRONTEND_HOST%:%FRONTEND_PORT%      ║
echo   ╚══════════════════════════════════════════╝
echo.

:: ── Check for Python ──────────────────────────────────────────
where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python is not installed or not in PATH.
  echo         Install Python 3.11+ from https://python.org
  pause
  exit /b 1
)

:: ── Check for Node.js ─────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo         Install Node.js LTS from https://nodejs.org
  pause
  exit /b 1
)

:: ── Kill stale processes on our ports ─────────────────────────
echo [1/5] Checking ports...
for /f "tokens=5" %%p in ('netstat -aon -p tcp 2^>nul ^| findstr ":%BACKEND_PORT% " ^| findstr "LISTENING"') do (
  echo       Stopping stale process on :%BACKEND_PORT% (PID %%p)
  taskkill /PID %%p /F >nul 2>&1
)
for /f "tokens=5" %%p in ('netstat -aon -p tcp 2^>nul ^| findstr ":%FRONTEND_PORT% " ^| findstr "LISTENING"') do (
  echo       Stopping stale process on :%FRONTEND_PORT% (PID %%p)
  taskkill /PID %%p /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: ── Install frontend dependencies if needed ───────────────────
echo [2/5] Checking frontend dependencies...
if not exist "%TERMINAL_DIR%\node_modules\.package-lock.json" (
  echo       Running npm install...
  cd /d "%TERMINAL_DIR%"
  call npm install --loglevel=error
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
  cd /d "%ROOT%"
)
echo       Dependencies OK.

:: ── Start Backend ─────────────────────────────────────────────
echo [3/5] Starting backend gateway on :%BACKEND_PORT%...
start "Cerious Backend" /min cmd /c "cd /d "%ROOT%" && python -m uvicorn services.gateway.main:app --host %BACKEND_HOST% --port %BACKEND_PORT% 2>&1"

:: ── Wait for backend health ───────────────────────────────────
echo       Waiting for backend...
set RETRIES=0
:wait_backend
timeout /t 1 /nobreak >nul
set /a RETRIES+=1
curl -s -o nul -w "%%{http_code}" http://%BACKEND_HOST%:%BACKEND_PORT%/api/health 2>nul | findstr "200" >nul
if errorlevel 1 (
  if %RETRIES% geq 30 (
    echo [ERROR] Backend did not start within 30 seconds.
    echo         Check cerious-backend.err.log for errors.
    pause
    exit /b 1
  )
  goto wait_backend
)
echo       Backend ready.

:: ── Start Frontend ────────────────────────────────────────────
echo [4/5] Starting frontend dev server on :%FRONTEND_PORT%...
start "Cerious Frontend" /min cmd /c "cd /d "%TERMINAL_DIR%" && set PATH=C:\Program Files\nodejs;%%PATH%% && npx vite --host %FRONTEND_HOST% --port %FRONTEND_PORT% 2>&1"

:: ── Wait for frontend ─────────────────────────────────────────
echo       Waiting for frontend...
set RETRIES=0
:wait_frontend
timeout /t 1 /nobreak >nul
set /a RETRIES+=1
curl -s -o nul -w "%%{http_code}" http://%FRONTEND_HOST%:%FRONTEND_PORT%/ 2>nul | findstr "200" >nul
if errorlevel 1 (
  if %RETRIES% geq 20 (
    echo [ERROR] Frontend did not start within 20 seconds.
    pause
    exit /b 1
  )
  goto wait_frontend
)
echo       Frontend ready.

:: ── Open Browser ──────────────────────────────────────────────
echo [5/5] Opening terminal in browser...
echo.
start "" "http://%FRONTEND_HOST%:%FRONTEND_PORT%/?cerious_view=canvas"

echo   ╔══════════════════════════════════════════╗
echo   ║          TERMINAL IS RUNNING             ║
echo   ║                                          ║
echo   ║  Close this window to stop all services  ║
echo   ╚══════════════════════════════════════════╝
echo.
echo   Press any key to SHUT DOWN the terminal...
pause >nul

:: ── Shutdown ──────────────────────────────────────────────────
echo.
echo Shutting down Cerious Systems...
taskkill /FI "WINDOWTITLE eq Cerious Backend*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Cerious Frontend*" /F >nul 2>&1
echo Done.
timeout /t 2 /nobreak >nul
