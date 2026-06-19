!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current
  Delete "$SMSTARTUP\Cerious Systems Startup Service.lnk"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current
  Delete "$SMSTARTUP\Cerious Systems Startup Service.lnk"
!macroend
