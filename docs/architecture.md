# Architecture

This document describes Dikt's internal architecture and the extension points intended for scaling features and providers.

---

## High-Level Overview

- **Frontend (SolidJS)**:
  - Renders the pill + settings UI.
  - Registers the global shortcut.
  - Sends `start_recording` / `stop_and_transcribe` commands.
  - Listens for backend status events (`dictation:update`) and updates UI state.

- **Backend (Rust/Tauri)**:
  - Exposes a small command surface (Tauri commands) as an RPC boundary.
  - Runs the dictation state machine in a single orchestrator: `DictationSessionManager`.
  - Uses “ports” (traits) for infrastructure that varies by provider or OS.

---

## Backend Domain Layer

### State Machine

Owned by: `src-tauri/src/domain/manager.rs`

States (see `src-tauri/src/domain/types.rs`):
- `idle`
- `recording`
- `transcribing`
- `pasting`
- `done`
- `error`

The manager is responsible for all transitions and emits `DictationUpdate` events.

### Ports (Interfaces)

Defined in `src-tauri/src/domain/ports.rs`:
- `SettingsStore`: load/save settings
- `Transcriber`: OpenAI-compatible transcription for a WAV buffer
- `Paster`: paste text into the active application

Default implementations live in `src-tauri/src/domain/impls.rs`.

This keeps the domain logic stable while allowing swapping implementations for:
- New transcription providers (OpenAI, Groq, custom, etc.)
- OS-specific paste behavior (Cmd+V vs Ctrl+V, platform quirks)
- Different settings persistence strategies (file, keychain, enterprise managed)

---

## Backend Command Layer

Commands are thin adapters around the manager:

File: `src-tauri/src/commands.rs`

- `start_recording`: triggers the manager and emits status updates.
- `stop_and_transcribe`: stops, transcribes, pastes, emits status updates, returns final text.
- `get_settings` / `save_settings`: delegated to the manager (settings store).
- UI commands (`resize_window`, `position_window_bottom`): window management helpers.

---

## Frontend Event Contract

The backend emits status updates as a Tauri event:
- Event name: `dictation:update`
- Payload shape:
  - `state`: `idle | recording | transcribing | pasting | done | error`
  - `message?`: human-readable status or error string
  - `text?`: transcription text (typically present on `done`)

Frontend listener: `src/App.tsx`

---

## Extension Guidelines

1. Prefer adding new providers by implementing `Transcriber` rather than branching inside the manager.
2. Prefer OS-specific logic in `Paster` rather than in the manager.
3. Keep Tauri commands thin: they should delegate to the manager and emit events.
