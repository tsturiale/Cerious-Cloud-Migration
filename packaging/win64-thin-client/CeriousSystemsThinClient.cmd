@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0CeriousSystemsThinClient.ps1" %*
endlocal
