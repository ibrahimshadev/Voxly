# PRD: Dikt - Cross-Platform Voice-to-Text Transcription App

## Executive Summary

Build a minimalist, cross-platform voice-to-text application that activates via global keyboard shortcut, displays a floating transcription UI, and auto-pastes the result into the currently focused input field. Uses OpenAI-compatible cloud APIs for transcription.

**Build strategy:** implement and validate **hold-to-talk on Windows first**, then expand to macOS/Linux and harden permissions + focus behavior.

---

## 1. Competitive Analysis

### Apps Researched

| App | Platforms | Speech Engine | Key Differentiator | Pricing |
|-----|-----------|---------------|-------------------|---------|
| **Wispr Flow** | Mac, Windows, iOS | Cloud AI | AI auto-edits, tone adaptation | Subscription |
| **Monologue** | Unknown | Cloud | 3x faster workflow, glassmorphism UI | Unknown |
| **HyperWhisper** | macOS, Windows | Hybrid (local + cloud APIs) | Supports Groq, Deepgram, OpenAI | $39 one-time |
| **Superwhisper** | macOS | Multiple AI providers | Super Mode, meeting assistant | Subscription |

### Common Patterns

1. **Global hotkey activation** (typically Ctrl+Space / Cmd+Space or configurable)
2. **Push-to-talk** or toggle recording modes
3. **Floating minimal UI** showing recording/transcription state
4. **Auto-paste** into active text field
5. **Cloud API flexibility** - users choose provider
6. **Glassmorphism dark UI** - modern, semi-transparent look

---

## 2. Technical Architecture

### Framework: **Tauri 2.x**

**Why Tauri:**
- **Bundle size**: 3-10MB vs 50MB+ (Electron)
- **RAM usage**: Significantly lower
- **Global shortcuts**: First-class plugin support
- **Cross-platform**: Windows, macOS, Linux

### Speech Recognition: **OpenAI-Compatible APIs**

**Why Cloud APIs (no built-in engine):**
- No native ML dependencies (simpler build)
- App stays under 10MB (no model downloads)
- Users choose their provider (cost/speed/privacy tradeoffs)
- Always uses latest cloud models
- Faster development

**Supported Providers:**
| Provider | API URL | Pricing |
|----------|---------|---------|
| **Groq** | `https://api.groq.com/openai/v1/audio/transcriptions` | Free tier |
| **OpenAI** | `https://api.openai.com/v1/audio/transcriptions` | Paid |
| **Custom** | Any OpenAI-compatible endpoint | Varies |

### Frontend: **SolidJS + Tailwind CSS**

- Lightweight reactive framework
- Glassmorphism dark theme
- Simple state management

---

## 3. Core Features (MVP)

### Must Have (P0)

#### 3.1 Global Keyboard Shortcut
- Configurable hotkey (default: `CommandOrControl+Space`)
- Works from any application
- **Push-to-talk mode**: Hold to record, release to transcribe

#### 3.2 Floating Recording UI
- Minimal overlay window (pill-shaped)
- States: Idle → Recording → Transcribing → Done
- Visual feedback: waveform or pulsing indicator
- Always on top, draggable position
- **Glassmorphism dark theme** (backdrop blur, semi-transparent)

#### 3.3 Cloud Transcription
- Record audio from microphone
- Send to configured API endpoint
- Display transcribed text
- Handle API errors gracefully

#### 3.4 Auto-Paste to Active Input
- Copy transcription to clipboard
- Simulate paste (Ctrl+V / Cmd+V)
- Cross-platform clipboard handling

#### 3.5 Settings Screen
- **Provider dropdown**: Groq, OpenAI, Custom
- **API URL**: Auto-filled for presets, editable for custom
- **API Key**: Masked input, securely stored
- **Model selection**: whisper-large-v3, whisper-1, etc.
- **Test Connection** button
- **Hotkey configuration**

#### 3.6 System Tray Integration
- Minimize to tray
- Quick settings access
- Quit option

---

## 4. User Flow

```
1. User configures API key in Settings (one-time)
                    ↓
2. User presses and HOLDS global hotkey
                    ↓
3. Floating UI appears showing "Recording..." with waveform
                    ↓
4. User speaks while holding the key
                    ↓
5. User RELEASES the hotkey
                    ↓
6. UI shows "Transcribing..." with spinner
                    ↓
7. Audio sent to cloud API → text returned
                    ↓
8. Transcribed text appears briefly in floating UI
                    ↓
9. Text is automatically pasted into focused input
                    ↓
10. Floating UI fades after 2 seconds
```

---

## 5. Technical Implementation

### Project Structure

```
dikt/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs         # Entry point, Tauri setup
│   │   ├── audio.rs        # Microphone capture (cpal)
│   │   ├── transcribe.rs   # API calls to cloud providers
│   │   ├── hotkey.rs       # Global shortcut handling
│   │   ├── clipboard.rs    # Paste functionality
│   │   └── settings.rs     # Config & credential storage
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── FloatingUI.tsx  # Main overlay component
│   │   ├── Waveform.tsx    # Audio visualization
│   │   ├── Spinner.tsx     # Loading indicator
│   │   └── Settings.tsx    # Settings panel
│   ├── stores/
│   │   └── app.ts          # State management
│   └── styles/
│       └── globals.css     # Tailwind + glassmorphism
├── package.json
└── README.md
```

### Key Dependencies

**Rust (Tauri backend):**
```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-global-shortcut = "2"
tauri-plugin-shell = "2"
cpal = "0.15"                    # Audio capture
reqwest = { version = "0.12", features = ["json", "multipart"] }
arboard = "3"                    # Cross-platform clipboard
enigo = "0.2"                    # Keyboard simulation
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
keyring = "2"                    # Secure credential storage
hound = "3"                      # WAV encoding
```

**Frontend (package.json):**
```json
{
  "dependencies": {
    "solid-js": "^1.8",
    "@tauri-apps/api": "^2"
  },
  "devDependencies": {
    "tailwindcss": "^3.4",
    "vite": "^5",
    "vite-plugin-solid": "^2"
  }
}
```

### Implementation Phases

#### Phase 1: Windows MVP (Hold-to-Talk + Provider Abstraction)
**Goal:** On Windows, user holds a global hotkey to record, releases to transcribe via a configurable OpenAI-compatible endpoint, and the text is pasted into the previously focused app.

- [ ] Initialize Tauri 2.x + SolidJS template
- [ ] Floating overlay window (always-on-top, frameless)
- [ ] Settings screen (from day 1): provider presets (OpenAI / Groq / Custom) with editable URL
- [ ] Settings screen: API Base URL (OpenAI-compatible; user-editable)
- [ ] Settings screen: API Key stored in OS credential store (`keyring`)
- [ ] Settings screen: Model string (free text with sensible defaults; do not rely on provider-specific model catalogs)
- [ ] Settings screen: Hotkey config (single chord)
- [ ] Settings screen: Test Connection button (basic request + clear error output)
- [ ] Global **hold-to-talk** on Windows: key down starts recording; key up stops and triggers transcription
- [ ] Hold-to-talk implementation detail: implement global key down/up detection on Windows (not guaranteed by a “hotkey triggered” API alone)
- [ ] Audio capture: capture microphone audio via `cpal`
- [ ] Audio encoding: encode to WAV for upload (`hound`)
- [ ] Cloud transcription: POST multipart form-data to `{baseUrl}/audio/transcriptions` (OpenAI-compatible)
- [ ] Cloud transcription: parse `{ "text": "..." }`
- [ ] Cloud transcription: handle auth/network/rate-limit errors
- [ ] Auto-paste (Windows): copy to clipboard (`arboard`)
- [ ] Auto-paste (Windows): simulate Ctrl+V (`enigo`)
- [ ] Minimal UX: overlay states (Recording → Transcribing → Done/Error)
- [ ] Minimal UX: mic feedback (pulsing indicator; waveform optional)

#### Phase 2: Cross-Platform + Permissions + Focus Guarantees + Polish
**Goal:** Match Phase 1 behavior on macOS/Linux and harden focus/permission flows. Add “nice but non-essential” UX.

- [ ] Hold-to-talk on macOS/Linux (global key down/up): implement per OS/environment; document limitations (Wayland vs X11)
- [ ] Overlay focus spec + implementation: ensure overlay does not steal focus at paste time (or restore focus deterministically)
- [ ] Overlay focus spec + implementation: define click/drag behavior without breaking paste target
- [ ] Permissions UX: microphone permissions guidance per OS
- [ ] Permissions UX: accessibility / input-injection permission guidance where needed
- [ ] System tray integration
- [ ] Better error UX (toasts, retry, “copy only” fallback)
- [ ] Cross-platform testing + packaging

---

## 6. UI Design

### Theme: Glassmorphism Dark

```css
/* Base colors */
--bg-primary: rgba(10, 10, 10, 0.8);
--bg-secondary: rgba(26, 26, 26, 0.9);
--accent: #19d0e8;
--text: #ffffff;
--text-muted: #a0a0a0;

/* Glassmorphism */
backdrop-filter: blur(20px);
background: rgba(0, 0, 0, 0.6);
border: 1px solid rgba(255, 255, 255, 0.1);
border-radius: 16px;
```

### Floating UI States

```
┌─────────────────────────────────────┐
│  IDLE (hidden)                      │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐  ← glassmorphism
│  🔴 Recording...  ▂▃▅▇▅▃▂          │    backdrop-blur
│      [waveform animation]           │    bg-black/60
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  ⏳ Transcribing...                 │
│      [spinner]                      │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  ✓ "Your transcribed text..."      │
│      [fades after 2s]               │
└─────────────────────────────────────┘
```

---

## 7. Technical Considerations

### API Integration

**Request format (OpenAI-compatible):**
```http
POST /v1/audio/transcriptions
Content-Type: multipart/form-data

file: audio.wav
model: whisper-large-v3
```

**Response:**
```json
{
  "text": "Transcribed text here"
}
```

### Cross-Platform Challenges

| Challenge | Solution |
|-----------|----------|
| Global hotkeys | `tauri-plugin-global-shortcut` |
| Hold-to-talk (key down/up) | Requires OS-specific global key down/up detection; implement Windows first, then macOS/Linux |
| Audio capture | `cpal` crate |
| Secure storage | `keyring` crate |
| Keyboard simulation | `enigo` crate |
| Floating window | Tauri window config (always_on_top, decorations: false) |

### Performance Targets

| Metric | Target |
|--------|--------|
| Hotkey response | < 100ms to show UI |
| Recording start | < 200ms from hotkey press |
| API latency | < 2s for 10s audio (depends on provider) |
| Memory usage | < 100MB |
| App bundle | < 10MB |

---

## 8. Verification Plan

### Testing Checklist

- [ ] Configure Groq API key in settings
- [ ] Test connection succeeds
- [ ] Press hotkey → recording UI appears
- [ ] Speak → release → transcription appears
- [ ] Text pastes into active input (browser, VS Code, etc.)
- [ ] Switch to OpenAI provider → works
- [ ] Custom URL with local endpoint → works
- [ ] System tray menu works
- [ ] Settings persist across restarts

### Cross-Platform Testing

- [ ] Windows 10/11
- [ ] macOS (Intel + Apple Silicon)
- [ ] Linux (Ubuntu)

---

## 9. Out of Scope (MVP)

- Offline transcription
- Multiple languages (English only)
- AI text enhancement
- Meeting recording
- Mobile apps
- Streaming transcription (word-by-word)

---

## 10. Success Metrics

- **Works with cloud APIs**: Groq, OpenAI, custom endpoints
- **Fast**: < 3s from speech end to pasted text (network dependent)
- **Lightweight**: < 10MB app bundle
- **Cross-platform**: Identical UX on Windows, macOS, Linux
- **Simple setup**: API key + one click to start
