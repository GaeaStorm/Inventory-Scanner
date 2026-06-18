# Native label printing fix (v14)

The label printer no longer uses `window.open()`. The desktop window intentionally denies renderer-created windows as part of its security policy, so the previous popup-based print preview was always rejected.

The renderer now sends the prepared label HTML through the preload bridge. The Electron main process writes it to a temporary local file, loads that file in a hidden sandboxed `BrowserWindow`, and calls `webContents.print()` to open the operating system print dialog. Temporary print files are removed after printing or cancellation.

This is not a macOS printer-permission issue. It is an Electron window-policy issue fixed inside the application.
