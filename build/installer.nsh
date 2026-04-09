; PixelForge NSIS Custom Install Script
; Creates PixelForge output folders in user's Documents on install

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
