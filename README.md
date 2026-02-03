# Dikt

A minimalist, cross-platform voice-to-text application. Hold a hotkey, speak, and your words are transcribed and pasted into any app.

## Features

- **Hold-to-talk**: Press and hold your configured hotkey (default: `CommandOrControl+Space`) to record, release to transcribe
- **Auto-paste**: Transcribed text is automatically pasted into the focused input
- **Cloud transcription**: Uses OpenAI-compatible APIs (Groq free tier, OpenAI, or custom)
- **Floating overlay**: Minimal glassmorphism UI shows recording/transcribing status
- **Cross-platform**: Windows, macOS, Linux

## Quick Start

1. Download the latest release for your platform
2. Run the app
3. Configure your API key in Settings:
   - **Groq** (free): Get a key at [console.groq.com](https://console.groq.com)
   - **OpenAI** (paid): Get a key at [platform.openai.com](https://platform.openai.com)
4. Hold your hotkey (default: `CommandOrControl+Space`) and speak
5. Release to transcribe and auto-paste

## Supported Providers

| Provider | API URL | Pricing |
|----------|---------|---------|
| Groq | `https://api.groq.com/openai/v1` | Free tier available |
| OpenAI | `https://api.openai.com/v1` | Pay per use |
| Custom | Any OpenAI-compatible endpoint | Varies |

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/)
- Platform-specific dependencies:

**Windows:**
- Visual Studio Build Tools with C++ workload

**macOS:**
- Xcode Command Line Tools: `xcode-select --install`

**Linux (Ubuntu/Debian):**
```bash
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libasound2-dev \
  libssl-dev \
  libxdo-dev
```

### Run in Development

```bash
npm install
npm run tauri dev
```

### Build for Production

```bash
npm run tauri build
```

Outputs:
- **Windows**: `src-tauri/target/release/bundle/msi/*.msi`
- **macOS**: `src-tauri/target/release/bundle/dmg/*.dmg`
- **Linux**: `src-tauri/target/release/bundle/deb/*.deb`, `*.AppImage`

## Tech Stack

- **Framework**: [Tauri 2.x](https://tauri.app/)
- **Frontend**: [SolidJS](https://solidjs.com/) + CSS
- **Backend**: Rust
- **Audio**: [cpal](https://github.com/RustAudio/cpal)
- **Transcription**: OpenAI Whisper API (cloud)

## Security & Data Storage

- **Audio**: recorded locally and sent to the configured OpenAI-compatible endpoint for transcription.
- **Paste behavior**: Dikt writes the transcript to the system clipboard and triggers paste (Windows/Linux: `Ctrl+V`, macOS: `Cmd+V`).
  - Note: clipboard managers may still record clipboard changes even if we later restore the clipboard.
- **Settings**:
  - Base URL / model / hotkey are stored in a local JSON file:
    - Windows: `%APPDATA%\\dikt\\settings.json`
    - Linux/macOS: `$XDG_CONFIG_HOME/dikt/settings.json` (or `~/.config/dikt/settings.json`)
  - API key is stored using the OS credential manager via `keyring` when available.
  - If the OS credential manager is unavailable/fails, Dikt falls back to storing an **obfuscated** value in `settings.json` (`encrypted_api_key`). This is not strong encryption.

## Project Structure

```
dikt/
├── src/                    # Frontend (SolidJS)
│   ├── App.tsx             # Main UI component
│   ├── main.tsx            # Entry point
│   └── style.css           # Styles
├── src-tauri/              # Backend (Rust)
│   ├── src/
│   │   ├── main.rs         # Tauri entry point
│   │   ├── audio.rs        # Microphone capture
│   │   ├── transcribe.rs   # API client
│   │   ├── clipboard.rs    # Paste simulation
│   │   ├── settings.rs     # Configuration
│   │   └── commands.rs     # Tauri commands
│   ├── Cargo.toml
│   └── tauri.conf.json
├── PRD.md                  # Product requirements
└── research.md             # Technical research
```

## License

MIT
