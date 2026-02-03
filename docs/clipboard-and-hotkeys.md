# Clipboard-Safe Paste and Hotkey Control

This document describes a platform-specific plan for:
1) Clipboard-safe paste (insert text while restoring user clipboard)
2) Modifier-only hotkey detection and OS-level override behavior

Scope: Windows and macOS. This is a research/plan doc; no code is implemented here.

---

## 1. Clipboard-Safe Paste

### Windows Plan

**Goal:** Paste text into the focused app while restoring the user clipboard.

**Steps**
1. Read current clipboard content and metadata:
   - Open clipboard, read `CF_UNICODETEXT` if present.
   - Save clipboard sequence number (`GetClipboardSequenceNumber`).
2. Write transcription to clipboard:
   - `OpenClipboard` → `EmptyClipboard` → `SetClipboardData(CF_UNICODETEXT)`.
3. Trigger paste:
   - Use `SendInput` to synthesize `Ctrl+V`.
4. Restore previous clipboard:
   - Re-open clipboard and restore the previous content.
   - If clipboard sequence changed externally between step 1 and 4, skip restore to avoid clobbering user changes.

**Primary APIs (Win32)**
- `OpenClipboard`, `CloseClipboard`, `EmptyClipboard`, `GetClipboardData`, `SetClipboardData`
- `GetClipboardSequenceNumber`
- `SendInput`

**Risks**
- UIPI blocks input injection for higher-integrity targets.
- Clipboard can be locked by other apps; retries needed.

**References**
- Clipboard operations: https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-operations
- Using the clipboard: https://learn.microsoft.com/en-us/windows/win32/dataxchg/using-the-clipboard
- SendInput: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput

---

### macOS Plan

**Goal:** Paste text into the focused app while restoring the user pasteboard.

**Steps**
1. Snapshot pasteboard:
   - Read `NSPasteboard.general` contents (string types).
2. Write transcription to pasteboard:
   - `setString:forType:`
3. Trigger paste:
   - Use Quartz Event Services to synthesize Command+V.
4. Restore previous pasteboard:
   - Restore saved contents to the general pasteboard.

**Primary APIs (AppKit/Quartz)**
- `NSPasteboard` (general pasteboard)
- Quartz Event Services (keyboard injection)

**Permissions**
- Accessibility permissions required for global key injection.

**References**
- Pasteboard overview: https://developer.apple.com/library/archive/documentation/General/Devpedia-CocoaApp-MOSX/Pasteboard.html
- NSPasteboard setString: https://learn.microsoft.com/en-us/dotnet/api/appkit.nspasteboarditem.setstringfortype
- Event monitoring: https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/MonitoringEvents/MonitoringEvents.html

---

## 2. Modifier-Only Hotkeys (Ctrl + Win) and OS Overrides

### Windows (Ctrl + Win)

**Problem:** Standard hotkey APIs require a non-modifier key. `Ctrl+Win` alone cannot be registered via `RegisterHotKey`.

**Plan (Windows-only, advanced)**
1. Install a low-level keyboard hook: `SetWindowsHookEx(WH_KEYBOARD_LL, ...)`.
2. Detect modifier state:
   - Track `Ctrl` and `Win` key down/up.
3. When both are pressed, trigger start/stop dictation.
4. Optionally suppress further propagation by returning non-zero.

**Primary APIs**
- `SetWindowsHookEx`, `LowLevelKeyboardProc`, `CallNextHookEx`

**Risks**
- Hooks must be fast; Windows can remove slow hooks.
- Interferes with OS-reserved key behavior (Win key).

**References**
- RegisterHotKey: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey
- SetWindowsHookEx: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowshookexa
- LowLevelKeyboardProc: https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc

---

### macOS (Global Override)

**Problem:** There is no Win key. Modifier-only override or blocking OS shortcuts is limited.

**Plan (macOS, advanced)**
1. Use a lower-level event tap (Quartz) to monitor key events.
2. Detect desired modifier state and trigger dictation.
3. Note: Standard global event monitors cannot prevent event delivery.

**Permissions**
- Accessibility permission required.

**Reference**
- Event monitoring (limitations and permissions): https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/MonitoringEvents/MonitoringEvents.html

---

## Recommendations

1. Prefer standard, OS-supported hotkeys that include a non-modifier key.
2. Use clipboard-safe paste with restore to preserve user clipboard.
3. Only implement modifier-only hotkeys on Windows if absolutely required, and gate it behind a settings toggle.
