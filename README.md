# Voxly

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Tested_on-Windows-0078D6.svg)](#platform-support)
[![Built with Tauri](https://img.shields.io/badge/Built_with-Tauri_2-FFC131.svg)](https://tauri.app/)

Hold a hotkey, speak, release. Your words are transcribed, cleaned up by AI, and pasted into whatever app you're using.

<!-- Replace with your GIF once recorded -->
<!-- ![Voxly Demo](assets/demo.gif) -->

## Quick Start

1. Download the latest release for your platform
2. Run the app
3. Configure your API key in Settings:
   - **Groq** (free): Get a key at [console.groq.com](https://console.groq.com)
   - **OpenAI** (paid): Get a key at [platform.openai.com](https://platform.openai.com)
4. Hold your hotkey (default: `Ctrl+Space`) and speak
5. Release to transcribe and auto-paste

## Features

### Voice Transcription

Hold your hotkey, speak, release. Voxly records audio from your microphone, sends it to an OpenAI-compatible transcription API, and pastes the result into whatever app has focus. The entire flow happens in a few seconds.

Two hotkey modes are available:
- **Hold to talk** (default) — hold the hotkey while speaking, release to transcribe
- **Press to toggle** — press once to start recording, press again to stop and transcribe

Output can be configured to either paste directly (preserving your existing clipboard) or paste and copy the transcription to the clipboard.

### Modes

Modes let you run a second LLM call on the transcribed text before it gets pasted. Each mode has a name, a system prompt, and a chat model. The transcription is sent as the user message, and the LLM's response replaces the raw transcription.

Three built-in modes are included:
- **Clean Draft** — removes filler words and fixes grammar while preserving your tone
- **Email Composer** — converts spoken draft into a professional email with subject and body
- **Developer Mode** — formats speech into clear instructions for coding agents (like Claude Code, Cursor, etc.)

You can create custom modes with any system prompt. Activate a mode to use it, or deactivate all modes to paste raw transcriptions. The model list is fetched live from your provider's `/models` endpoint.

### Vocabulary

Define custom word replacements for terms the transcription model frequently gets wrong. Each vocabulary entry maps a word to one or more replacement patterns. When any replacement appears in the transcribed text, it gets corrected to the target word.

Useful for names, technical jargon, or domain-specific terms that speech-to-text models struggle with. Entries can be individually enabled or disabled without deleting them.

### History

Every transcription is saved locally with a timestamp. The History tab shows recent transcriptions with relative timestamps (e.g. "5m ago") and exact times on hover. If a mode was active, both the original and formatted versions are shown. You can copy any past transcription to the clipboard or delete individual entries.

### Floating Overlay

A minimal pill sits at the bottom of your screen showing the current state: recording, transcribing, formatting (when a mode is active), or done. It stays on top of all windows and passes through mouse clicks when not hovered.

### System Tray

Voxly minimizes to the system tray. Right-click for quick access to Settings, Reset Position, or Quit. Left-click toggles the overlay visibility.

## Supported Providers

| Provider | API URL | Pricing |
|----------|---------|---------|
| Groq | `https://api.groq.com/openai/v1` | Free tier available |
| OpenAI | `https://api.openai.com/v1` | Pay per use |
| Custom | Any OpenAI-compatible endpoint | Varies |

Voxly uses the OpenAI-compatible API format. Any provider that supports `/audio/transcriptions` (for speech-to-text) and `/chat/completions` (for modes) will work with the Custom provider option.

## Platform Support

Voxly is built to be cross-platform (Windows, macOS, Linux), but has only been tested on **Windows** so far. If you're on macOS or Linux and want to help test, bug reports and feedback are very welcome.

## Security & Data Storage

- **Audio** is recorded locally and sent to your configured API endpoint for transcription. No audio is stored on disk.
- **Transcription history** is stored in a local JSON file alongside settings.
- **Paste behavior**: Voxly writes the transcript to the system clipboard and triggers paste (`Ctrl+V` on Windows/Linux, `Cmd+V` on macOS). Clipboard managers may record these changes.
- **Settings** (provider, base URL, model, hotkey, vocabulary, modes) are stored in a local JSON file:
  - Windows: `%APPDATA%\dikt\settings.json`
  - Linux/macOS: `$XDG_CONFIG_HOME/dikt/settings.json` (or `~/.config/dikt/settings.json`)
- **API key** is stored using the OS credential manager via `keyring` when available. If unavailable, Voxly falls back to an obfuscated value in `settings.json`.

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

### Tech Stack

- **Framework**: [Tauri 2.x](https://tauri.app/)
- **Frontend**: [SolidJS](https://solidjs.com/) + Tailwind CSS
- **Backend**: Rust
- **Audio**: [cpal](https://github.com/RustAudio/cpal)
- **Transcription**: OpenAI Whisper API (cloud)
- **Formatting**: OpenAI-compatible Chat Completions API (cloud)

## License

MIT
