!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current
  IfFileExists "$INSTDIR\Cerious Systems.exe" 0 +3
    CreateShortcut "$SMSTARTUP\Cerious Systems Startup Service.lnk" "$INSTDIR\Cerious Systems.exe" "--startup-service" "$INSTDIR\Cerious Systems.exe" 0
    Goto startup_service_done
  IfFileExists "$INSTDIR\cerious-systems-desktop.exe" 0 startup_service_done
    CreateShortcut "$SMSTARTUP\Cerious Systems Startup Service.lnk" "$INSTDIR\cerious-systems-desktop.exe" "--startup-service" "$INSTDIR\cerious-systems-desktop.exe" 0
  startup_service_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current
  Delete "$SMSTARTUP\Cerious Systems Startup Service.lnk"
!macroend
