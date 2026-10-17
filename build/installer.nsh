; =============================================================================
; KVox Desktop NSIS additions (marinoscar/kvox#587)
; =============================================================================
;
; Uninstalling keeps the user's data (%APPDATA%\KVox: notes, documents, the
; graph, settings) unless the user answers Yes to "Remove my data". An update
; (the installer replacing an older version) never asks and never removes it,
; and a silent uninstall keeps it (/SD IDNO).
; =============================================================================

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Remove my data?$\r$\n$\r$\nAlso delete your KVox notes, documents, knowledge graph and settings from this computer ($APPDATA\${PRODUCT_NAME}). This cannot be undone.$\r$\n$\r$\nChoose No to keep them for a later installation." /SD IDNO IDNO kvox_keep_data
    RMDir /r "$APPDATA\${PRODUCT_NAME}"
    kvox_keep_data:
  ${endIf}
!macroend
