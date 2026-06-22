; PixelForge NSIS Custom Install Script
; Creates PixelForge output folders in user's Documents on install

!macro customPageAfterChangeDir
  Page custom pfConfirmDirShow

  Function pfConfirmDirShow
    ${If} ${isUpdated}
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "Ready to Install" "PixelForge will be installed in its own dedicated folder."

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    StrCpy $R8 "$INSTDIR"
    ${StrContains} $R9 "${APP_FILENAME}" "$INSTDIR"
    ${If} $R9 == ""
      StrCpy $R8 "$INSTDIR\${APP_FILENAME}"
    ${EndIf}

    ${NSD_CreateLabel} 0 6u 100% 28u "A dedicated PixelForge folder is created automatically inside the location you chose, so the app files are never mixed into that folder."
    Pop $0
    ${NSD_CreateLabel} 0 44u 100% 12u "PixelForge will be installed to:"
    Pop $0
    ${NSD_CreateLabel} 0 58u 100% 24u "$R8"
    Pop $0

    nsDialogs::Show
  FunctionEnd
!macroend

!macro customInstall
  ; Create output folders in user Documents
  SetShellVarContext current
  CreateDirectory "$DOCUMENTS\PixelForge"
  CreateDirectory "$DOCUMENTS\PixelForge\upscaled"
  CreateDirectory "$DOCUMENTS\PixelForge\compressed"

  ; Write a README in the output folder
  FileOpen $0 "$DOCUMENTS\PixelForge\README.txt" w
  FileWrite $0 "PixelForge Output Folders$\r$\n"
  FileWrite $0 "by Refora Technologies$\r$\n$\r$\n"
  FileWrite $0 "upscaled\   - AI upscaled images are saved here$\r$\n"
  FileWrite $0 "compressed\ - Compressed images are saved here$\r$\n$\r$\n"
  FileWrite $0 "You can change these paths in PixelForge Settings.$\r$\n"
  FileClose $0
!macroend

!macro customUnInstall
  ; Optionally clean up — we leave the output folders intact
  ; (user's images should not be deleted on uninstall)
!macroend
