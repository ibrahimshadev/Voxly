# Dikt — Current State

Snapshot of the app as of the latest uncommitted work on `main`.

---

## Two-Window Architecture

The app runs two separate Tauri windows:

| Window | Label | Size | Traits |
|--------|-------|------|--------|
| **Pill overlay** | `main` | 360x100 fixed | Transparent, undecorated, always-on-top, skip-taskbar |
| **Settings** | `settings` | 1100x720 | Decorated, resizable, hidden by default, centered |

Window detection at boot (`src/main.tsx`) reads `getCurrentWindow().label` and mounts `App` or `SettingsApp` accordingly.

---

## Pill Overlay (main window)

A tiny always-visible floating pill at the bottom of the screen. Fixed dimensions — never resized at runtime to avoid the WebView2 compositor bug.

### States

| State | Visual | Size |
|-------|--------|------|
| **idle** | 5 white dots | 48x20 |
| **recording** | iOS-style sine wave (SiriWave lib) | 90x28 |
| **transcribing / formatting / pasting** | Animated loading dots | 90x28 |
| **done** | Green checkmark | 90x28 |
| **error** | Red `!` + gear button | 90x28 |

### Interaction
- **Hover** shows a tooltip with the current hotkey and a gear button to open settings.
- **Drag** anywhere on the pill to reposition it.
- **Click-through** is enabled during idle (Win32 `WS_EX_TRANSPARENT` toggling via custom Rust code — tao's built-in method is bypassed).

### Key files
- `src/App.tsx` — hotkey registration, state machine, event listeners
- `src/components/Pill/Pill.tsx` — state-based rendering
- `src/components/Pill/SineWaves.tsx` — recording visualizer
- `src/components/Tooltip.tsx` — always-in-DOM, CSS opacity/transform transitions
- `src/style.css` — all pill styling, compositor-safe transitions only

---

## Settings Window (new design — in progress)

Three-panel layout built with SolidJS + Tailwind CSS v4. Dark theme with green (`#10B77F`) accent.

### Layout (`src/components/Settings/Layout.tsx`)

```
┌──────────────┬──────────────────────────────┬─────────────────┐
│              │                              │                 │
│   Sidebar    │       Main Content           │   Right Panel   │
│   264px      │       flex-1                 │   320px         │
│              │                              │                 │
│  - Settings  │   (active tab renders here)  │  AI Config      │
│  - History   │                              │  Enhancements   │
│  - Vocabulary│                              │  Live Input     │
│  - Modes     │                              │                 │
│              │                              │                 │
│  Theme toggle│                              │                 │
│  User card   │                              │                 │
└──────────────┴──────────────────────────────┴─────────────────┘
```

### Tabs — build status

| Tab | Status | Notes |
|-----|--------|-------|
| **Settings** | Built | Provider cards, connection details, API key, behavior (hotkey, trigger mode, output action) |
| **History** | Placeholder ("Coming soon") | Backend ready (`get_transcription_history`, `delete_`, `clear_`). State management wired in `SettingsApp.tsx`. |
| **Vocabulary** | Placeholder ("Coming soon") | Backend ready (`save_vocabulary`). State management + CRUD wired in `SettingsApp.tsx`. |
| **Modes** | Placeholder ("Coming soon") | Backend ready. State management + CRUD wired in `SettingsApp.tsx`. |

### Settings tab (`src/components/Settings/SettingsPage.tsx`)
- **Transcription Provider** — 3-card grid (Groq / OpenAI / Custom) with checkmark on active
- **Connection Details** — base URL, model dropdown (or text input for custom), API key with show/hide toggle and "Get key" link
- **Provider Actions** — Test Connection + Save Provider buttons, error/success message area
- **Behavior** — Global Hotkey input, Recording Trigger (Toggle/Hold), Output Action dropdown; auto-saves on change

### Right panel (`src/components/Settings/RightPanel.tsx`)
Currently **static mockup** — not wired to real data:
- 3 transcription mode cards (Clean Draft, Meeting Minutes, Developer Mode)
- Enhancement toggles (Auto-Punctuation, Vocabulary Boost)
- Live Input mic visualizer (static bars)

### Sidebar (`src/components/Settings/Sidebar.tsx`)
- Logo + version ("PRO v2.1")
- 4 nav items with Material Symbols icons
- Theme toggle (light/dark)
- Placeholder user card ("Alex Chen")

### Key files
- `src/SettingsApp.tsx` — all state management, CRUD operations, Tauri invoke calls
- `src/components/Settings/` — Layout, Sidebar, SettingsPage, RightPanel, Select
- `src/settings.css` — Tailwind v4 config + custom theme tokens

---

## Legacy Settings Panel (unused)

The old settings UI at `src/components/SettingsPanel/` is a compact collapsible panel that used to appear inside the main window. It used `solid-motionone` for animated tab transitions. All four tabs were fully implemented:

- `SettingsTab.tsx` — provider + API key form
- `VocabularyTab.tsx` + `VocabularyEditor.tsx` + `VocabularyEntry.tsx` — full vocabulary CRUD
- `HistoryTab.tsx` — transcription history list with copy/delete
- `ModesTab.tsx` — post-transcription formatting modes with model selection

This code is **not imported anywhere** in the current app — superseded by the new Settings window. It may serve as reference for re-implementing the remaining tabs in the new design.

---

## Mockups

Design targets for the new settings window live in `mockups/`:

| Mockup | Files | What it shows |
|--------|-------|---------------|
| **Settings** | `mockups/settings/screen.png`, `code.html` | Full settings tab with provider cards, connection form, behavior section, right panel with AI modes |
| **Vocabulary** | `mockups/vocabulary/screen.png`, `code.html` | Vocabulary table with word/phonetic/type columns, search, add button, right panel with dataset stats |

No mockups yet for History or Modes tabs.

---

## What's Next

The main remaining frontend work is porting the three unbuilt tabs (History, Vocabulary, Modes) from placeholder to the new three-panel design. The backend and state management for all of them is already wired in `SettingsApp.tsx` — only the UI components for the new layout need to be built. The legacy `SettingsPanel/` implementations and the HTML mockups can serve as reference.

The right panel content should also become dynamic — currently it shows hardcoded mode cards and toggles that don't connect to real settings state.
