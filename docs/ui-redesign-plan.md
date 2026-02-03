# Dikt UI Redesign Plan

## Summary

Redesign the dikt floating window from a card-based UI to a bottom-centered pill with system tray integration, new hotkey, and API key persistence fix.

---

## Pre-Implementation: File Organization

Move existing docs to `docs/` folder:
```bash
mv PRD.md docs/
mv research.md docs/
```

---

## Changes Overview

### 1. Floating Pill UI
- **Position:** Bottom center, 5px from bottom edge
- **Idle:** Shows hotkey text "Ctrl+Win"
- **Hover:** Settings gear fades in on right
- **Recording:** Sine wave animation (5 animated bars)
- **Settings click:** Panel slides up, has collapse button

### 2. New Hotkey
- **Default:** `CommandOrControl+Space`
  - Windows: Ctrl+Win
  - Linux: Ctrl+Super
  - macOS: Ctrl+Cmd

### 3. System Tray
- **Left-click:** Toggle floating bar visibility
- **Right-click:** Menu (Settings, Quit)
- App lives in tray, not taskbar

### 4. API Key Persistence Fix
- Try keyring first
- Fallback: encrypted storage in settings.json

### 5. Terminal Window Fix
- Already done: `#![cfg_attr(..., windows_subsystem = "windows")]`

---

## Files to Modify

| File | Changes |
|------|---------|
| `src-tauri/Cargo.toml` | Add `base64 = "0.22"` |
| `src-tauri/tauri.conf.json` | Window 200x48, tray config |
| `src-tauri/src/main.rs` | Tray setup, window positioning |
| `src-tauri/src/settings.rs` | API key fallback, new hotkey default |
| `src-tauri/src/commands.rs` | Add resize/position commands |
| `src/App.tsx` | Complete rewrite for pill UI |
| `src/style.css` | New pill styles, wave animation |

---

## Implementation Steps

### Step 1: Rust - Settings & Encryption Fallback

**`src-tauri/src/settings.rs`:**

```rust
// Change default hotkey
hotkey: "CommandOrControl+Space".to_string()

// Add to StoredSettings struct
#[serde(default)]
encrypted_api_key: Option<String>,

// Add encryption helpers
fn get_machine_key() -> Vec<u8> {
    let username = env::var("USERNAME").or(env::var("USER")).unwrap_or_default();
    let computer = env::var("COMPUTERNAME").or(env::var("HOSTNAME")).unwrap_or_default();
    // XOR-based key derivation
}

fn encrypt_api_key(api_key: &str) -> String { /* base64(xor(key, data)) */ }
fn decrypt_api_key(encrypted: &str) -> Option<String> { /* reverse */ }

// Update store_api_key: try keyring, fallback to encrypted file
// Update get_api_key: check keyring first, then encrypted file
```

### Step 2: Rust - Window Commands

**`src-tauri/src/commands.rs`:**

```rust
#[tauri::command]
pub fn resize_window(window: Window, width: u32, height: u32) -> Result<(), String> {
    window.set_size(...)?;
    // Reposition to keep bottom anchored
}

#[tauri::command]
pub fn position_window_bottom(window: Window) -> Result<(), String> {
    // Calculate bottom-center position
    // 5px from bottom edge
}
```

### Step 3: Rust - System Tray

**`src-tauri/src/main.rs`:**

```rust
.setup(|app| {
    // Create menu: Settings, Quit
    let menu = Menu::with_items(app, &[&settings, &quit])?;

    // Build tray
    TrayIconBuilder::new()
        .menu(&menu)
        .menu_on_left_click(false)  // Left-click toggles window
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "quit" => app.exit(0),
                "settings" => emit("show-settings"),
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click: toggle window visibility
        })
        .build(app)?;

    // Position window at bottom center
    position_window_bottom_center(app)?;
    Ok(())
})
```

### Step 4: Tauri Config

**`src-tauri/tauri.conf.json`:**

```json
{
  "app": {
    "windows": [{
      "width": 200,
      "height": 48,
      "resizable": false,
      "decorations": false,
      "transparent": true,
      "alwaysOnTop": true,
      "skipTaskbar": true,
      "center": false
    }],
    "trayIcon": {
      "iconPath": "icons/icon.png",
      "menuOnLeftClick": false
    }
  }
}
```

### Step 5: Frontend - App.tsx

```tsx
// Window sizes
const PILL_HEIGHT = 48;
const EXPANDED_HEIGHT = 380;

// State
const [isHovered, setIsHovered] = createSignal(false);

// Resize on settings toggle
const toggleSettings = async () => {
  const expanded = !showSettings();
  setShowSettings(expanded);
  await invoke('resize_window', {
    width: 200,
    height: expanded ? EXPANDED_HEIGHT : PILL_HEIGHT
  });
};

// Listen for tray "show-settings" event
onMount(async () => {
  await listen('show-settings', () => toggleSettings());
});

// JSX structure
<div class="pill-container">
  <Show when={showSettings()}>
    <div class="settings-panel">
      <header with collapse button>
      <fields>
      <actions>
    </div>
  </Show>

  <div class="pill" onMouseEnter/Leave>
    <Show when={idle}><span>{hotkey}</span></Show>
    <Show when={recording}><WaveBars /></Show>
    <button class="gear" classList={{visible: isHovered()}} />
  </div>
</div>
```

### Step 6: CSS - Key Styles

```css
.pill-container {
  display: flex;
  flex-direction: column-reverse;
  min-height: 100vh;
}

.pill {
  width: 180px;
  height: 40px;
  border-radius: 24px;
  background: rgba(18, 18, 18, 0.85);
  backdrop-filter: blur(16px);
}

.gear-button {
  opacity: 0;
  transition: opacity 0.2s;
}
.gear-button.visible { opacity: 1; }

.wave-bar {
  width: 3px;
  animation: wave 1s infinite;
}

@keyframes wave {
  0%, 100% { height: 4px; }
  50% { height: 18px; }
}

.settings-panel {
  animation: slideUp 0.2s;
  border-radius: 14px 14px 0 0;
}
```

---

## Verification

1. `npm run tauri dev` - Build and run
2. **Position:** Pill at bottom-center, 5px from edge
3. **Hover:** Gear icon fades in
4. **Settings:** Click gear → panel slides up, collapse → slides down
5. **Recording:** Hold Ctrl+Win → wave animation
6. **Tray:** Left-click toggles, right-click shows menu
7. **Persistence:** Settings survive restart (including API key)
8. **Windows release:** No terminal window

---

## Cross-Platform

| Platform | Tray | Hotkey | Keyring |
|----------|------|--------|---------|
| Windows | System tray | Ctrl+Win | Credential Manager + fallback |
| Linux | AppIndicator | Ctrl+Super | Secret Service |
| macOS | Menu bar | Ctrl+Cmd | Keychain |
