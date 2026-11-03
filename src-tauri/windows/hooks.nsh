; Keep the Windows install one-click friendly: the desktop shortcut is created
; for both interactive and silent NSIS installs. Tauri removes it on uninstall.
!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend
