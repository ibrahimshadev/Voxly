# Vocabulary Feature

## Overview

The vocabulary feature improves transcription accuracy by:
1. **Pre-transcription hints** - Send vocabulary words to Whisper API (provider-dependent)
2. **Post-transcription replacement** - Find & replace common mistakes (always applied)

## How It Works

```
┌──────────────────┐
│  User speaks     │
└────────┬─────────┘
         ▼
┌──────────────────┐
│  Audio recorded  │
└────────┬─────────┘
         ▼
┌──────────────────────────────────────────┐
│  API Call (Whisper/Groq)                 │
│  - file: audio.wav                       │
│  - model: whisper-large-v3-turbo         │
│  - prompt: "Vocabulary: Kubernetes, ..." │  ← Hint (if provider supports)
└────────┬─────────────────────────────────┘
         ▼
┌──────────────────────────────────────────┐
│  Post-Processing                         │
│  "cube and eighties" → "Kubernetes"      │  ← Word-boundary replacement
└────────┬─────────────────────────────────┘
         ▼
┌──────────────────┐
│  Paste result    │
└──────────────────┘
```

---

## Data Model

```typescript
interface VocabularyEntry {
  id: string;             // Unique ID for React keys
  word: string;           // Correct word: "Kubernetes"
  replacements: string[]; // Mistakes: ["cube and eighties", "kuber nettis"]
  enabled: boolean;       // Toggle on/off
}

interface Settings {
  // Existing fields...
  provider: 'groq' | 'openai' | 'custom';
  base_url: string;
  model: string;
  hotkey: string;
  api_key: string;
  // New field
  vocabulary: VocabularyEntry[];
}
```

---

## UI Architecture

### Component Structure

```
src/
├── App.tsx              # Root shell - tab state, window resize, hotkey
├── components/
│   ├── SettingsTab.tsx  # Provider, API key, model, hotkey settings
│   ├── VocabularyTab.tsx # Vocabulary list and editor
│   └── Pill.tsx         # Status pill (idle, recording, transcribing, etc.)
├── types.ts             # Shared TypeScript types
└── style.css            # All styles
```

### Root Shell (App.tsx)

```
┌─────────────────────────────────────┐
│  [Settings] [Vocabulary]       [v]  │  ← Tabs + collapse button
├─────────────────────────────────────┤
│                                     │
│  <ActiveTabComponent />             │  ← Renders based on activeTab
│                                     │
└─────────────────────────────────────┘
         ┌─────┐
         │ ••• │  ← Pill (always visible)
         └─────┘
```

### Vocabulary Tab

```
┌─────────────────────────────────────┐
│  ┌───────────────────────────────┐  │
│  │ Kubernetes              [✓]  │  │  ← Toggle enabled
│  │ 2 replacements          [x]  │  │  ← Delete button
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │ Anthropic               [✓]  │  │
│  │ 1 replacement           [x]  │  │
│  └───────────────────────────────┘  │
│                                     │
│  ┌───────────────────────────────┐  │
│  │ + Add word                   │  │  ← Click to expand editor
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

### Entry Editor (inline expansion)

```
┌─────────────────────────────────────┐
│  Word                               │
│  ┌───────────────────────────────┐  │
│  │ Kubernetes                    │  │
│  └───────────────────────────────┘  │
│                                     │
│  Replacements (one per line)        │
│  ┌───────────────────────────────┐  │
│  │ cube and eighties             │  │
│  │ kuber nettis                  │  │
│  └───────────────────────────────┘  │
│                                     │
│              [Cancel] [Save]        │
└─────────────────────────────────────┘
```

---

## Implementation Details

### Backend

| File | Changes |
|------|---------|
| `src-tauri/src/domain/types.rs` | Add `VocabularyEntry` struct |
| `src-tauri/src/settings.rs` | Add `vocabulary` field with `#[serde(default)]` |
| `src-tauri/src/transcribe.rs` | Add optional `prompt` parameter |
| `src-tauri/src/domain/manager.rs` | Add `apply_vocabulary_replacements()` |

### Frontend

| File | Changes |
|------|---------|
| `src/App.tsx` | Refactor to root shell with tab state |
| `src/components/SettingsTab.tsx` | Extract current settings UI |
| `src/components/VocabularyTab.tsx` | New vocabulary list + editor |
| `src/components/Pill.tsx` | Extract pill component |
| `src/types.ts` | Shared types |
| `src/style.css` | Tab styles, vocabulary styles |

---

## Critical Implementation Notes

### 1. Settings Migration (Backward Compatibility)

**Problem**: Existing users have `settings.json` without `vocabulary` field. Strict deserialization will fail.

**Solution**: Use `#[serde(default)]` in Rust:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct VocabularyEntry {
    pub id: String,
    pub word: String,
    #[serde(default)]
    pub replacements: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool { true }

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct AppSettings {
    // ... existing fields with #[serde(default)] ...
    #[serde(default)]
    pub vocabulary: Vec<VocabularyEntry>,
}
```

### 2. Provider Compatibility (Prompt Support)

**Problem**: Not all providers/models support the `prompt` parameter.

**Solution**: Provider capability map + graceful fallback:

```rust
fn supports_prompt(provider: &str, model: &str) -> bool {
    match provider {
        "groq" => true,  // All Whisper models on Groq support prompt
        "openai" => model.starts_with("whisper"),  // Only Whisper, not gpt-4o-transcribe
        "custom" => true,  // Assume yes, fail gracefully
        _ => false,
    }
}

// In transcribe():
let mut form = multipart::Form::new()
    .part("file", ...)
    .text("model", model);

if supports_prompt(provider, model) {
    if let Some(prompt) = prompt {
        form = form.text("prompt", prompt);
    }
}
```

### 3. Replacement Correctness (Word Boundaries)

**Problem**: Substring replacement causes false positives.
- "the" replacing inside "other" → "ooer"
- "AI" replacing inside "MAIL" → "MAIL" → "M**AI**L"

**Solution**: Word-boundary matching with proper escaping:

```rust
fn apply_vocabulary_replacements(
    text: &str,
    vocabulary: &[VocabularyEntry],
) -> Result<String, String> {
    let mut result = text.to_string();

    for entry in vocabulary.iter().filter(|e| e.enabled) {
        for replacement in &entry.replacements {
            if replacement.is_empty() {
                continue;
            }

            // Escape special regex chars, add word boundaries
            let escaped = regex::escape(replacement);
            let pattern = format!(r"(?i)\b{}\b", escaped);

            match Regex::new(&pattern) {
                Ok(re) => {
                    result = re.replace_all(&result, entry.word.as_str()).to_string();
                }
                Err(e) => {
                    // Log error but don't crash - skip this replacement
                    eprintln!("Invalid replacement pattern '{}': {}", replacement, e);
                }
            }
        }
    }

    Ok(result)
}
```

### 4. Limits and Truncation

**Constraints**:
- Max vocabulary entries: 100
- Max prompt length: 224 tokens (~800 chars for Whisper)
- Max replacements per entry: 10

**Truncation strategy**:
```rust
fn build_prompt(vocabulary: &[VocabularyEntry]) -> Option<String> {
    let words: Vec<&str> = vocabulary
        .iter()
        .filter(|e| e.enabled)
        .map(|e| e.word.as_str())
        .take(50)  // Limit entries
        .collect();

    if words.is_empty() {
        return None;
    }

    let mut prompt = format!("Vocabulary: {}", words.join(", "));

    // Truncate to ~800 chars if needed
    if prompt.len() > 800 {
        prompt.truncate(800);
        // Find last complete word
        if let Some(pos) = prompt.rfind(", ") {
            prompt.truncate(pos);
        }
    }

    Some(prompt)
}
```

---

## Test Plan

### Backend Tests

#### Settings Migration
```rust
#[test]
fn test_load_legacy_settings_without_vocabulary() {
    let json = r#"{"provider":"groq","base_url":"...","model":"...","hotkey":"..."}"#;
    let settings: AppSettings = serde_json::from_str(json).unwrap();
    assert!(settings.vocabulary.is_empty());
}

#[test]
fn test_load_settings_with_vocabulary() {
    let json = r#"{"provider":"groq",...,"vocabulary":[{"id":"1","word":"Test","replacements":["tset"],"enabled":true}]}"#;
    let settings: AppSettings = serde_json::from_str(json).unwrap();
    assert_eq!(settings.vocabulary.len(), 1);
}
```

#### Replacement Logic
```rust
#[test]
fn test_word_boundary_replacement() {
    let vocab = vec![VocabularyEntry {
        word: "the".into(),
        replacements: vec!["teh".into()],
        enabled: true,
        ..Default::default()
    }];

    // Should replace standalone "teh"
    assert_eq!(apply_replacements("teh cat", &vocab), "the cat");

    // Should NOT replace inside words
    assert_eq!(apply_replacements("other", &vocab), "other");
}

#[test]
fn test_case_insensitive_replacement() {
    let vocab = vec![VocabularyEntry {
        word: "Kubernetes".into(),
        replacements: vec!["cube and eighties".into()],
        enabled: true,
        ..Default::default()
    }];

    assert_eq!(apply_replacements("CUBE AND EIGHTIES", &vocab), "Kubernetes");
    assert_eq!(apply_replacements("Cube And Eighties", &vocab), "Kubernetes");
}

#[test]
fn test_disabled_entry_skipped() {
    let vocab = vec![VocabularyEntry {
        word: "Test".into(),
        replacements: vec!["tset".into()],
        enabled: false,
        ..Default::default()
    }];

    assert_eq!(apply_replacements("tset", &vocab), "tset");
}

#[test]
fn test_invalid_regex_does_not_crash() {
    let vocab = vec![VocabularyEntry {
        word: "Test".into(),
        replacements: vec!["[invalid".into()],  // Invalid regex
        enabled: true,
        ..Default::default()
    }];

    // Should not panic, just skip
    let result = apply_replacements("test [invalid", &vocab);
    assert!(result.is_ok());
}
```

#### Provider Compatibility
```rust
#[test]
fn test_prompt_support_detection() {
    assert!(supports_prompt("groq", "whisper-large-v3-turbo"));
    assert!(supports_prompt("openai", "whisper-1"));
    assert!(!supports_prompt("openai", "gpt-4o-transcribe"));
}
```

### Frontend Tests (Manual)

1. **Tab switching**: Click Settings/Vocabulary tabs, verify correct component loads
2. **Add entry**: Add new vocabulary entry, verify it appears in list
3. **Edit entry**: Click entry, modify, save, verify changes persist
4. **Delete entry**: Delete entry, verify removal
5. **Toggle entry**: Toggle enabled, verify visual feedback
6. **Persistence**: Add entries, restart app, verify they load
7. **Window resize**: Switch tabs, verify window resizes appropriately

---

## Open Questions (Resolved)

| Question | Decision |
|----------|----------|
| Word-boundary only by default? | **Yes** - use `\b` regex boundaries |
| Max vocabulary size? | **100 entries**, **50 in prompt** |
| Max prompt length? | **800 chars** (truncate with word boundary) |
| Keep original on collision? | **No** - replacements always win, user controls via enabled toggle |
