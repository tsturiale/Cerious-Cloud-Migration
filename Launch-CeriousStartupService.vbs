Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -STA -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\tstur\Documents\Codex\Cerious Systems\Cerious local\Start-CeriousStartupService.ps1""", 0, False
