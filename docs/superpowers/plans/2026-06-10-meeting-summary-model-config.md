# Meeting Summary Model Config (v2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the meeting AI summary's "thinking model" user-configurable (Groq / OpenAI / Custom — provider, base URL, model, API key) via a new tabbed meeting-config UI, replacing v1's hardcoded GPT-OSS-120B-on-Groq key resolution and request body.

**Architecture:** A parallel `summary_*` settings trio (independent per-provider key map, map-only encrypted persistence, no keyring) feeds a new `resolve_summary_config()` in `summarize.rs`; `run()` takes a `SummaryConfig` and builds a **provider/model-aware request body** (live-verified matrix — OpenAI rejects `include_reasoning` and `temperature` on some 5.4 models; Groq's `reasoning_effort` enum differs per model). The Meetings page config panel splits into `Capture | Transcription | AI Summary` tabs.

**Tech Stack:** Rust (serde, reqwest, rusqlite untouched), SolidJS + TypeScript, Tauri v2 commands.

**Spec:** `docs/superpowers/specs/2026-06-10-meeting-ai-summary-design.md` **§11 only** (v1 §1–§10 is shipped; §11 supersedes parts of it). Read §11.3's probe table and §11.6's matrix first — they are empirical ground truth (live API calls, 2026-06-10); do not "correct" them from memory.

---

## Environment

- Repo: `/mnt/c/Users/user/Documents/work/dikt` (Windows filesystem, WSL shell).
- **Rust tests:** Windows cargo from inside `src-tauri/`:
  `cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test <filter>`
  (WSL-native cargo cannot build this crate. If executing from a WSL-side worktree, prepend `WSLENV=CARGO_TARGET_DIR/p CARGO_TARGET_DIR=/mnt/c/Users/user/Documents/work/dikt/src-tauri/target` to share the warm target cache.)
- **Frontend check:** `cd /mnt/c/Users/user/Documents/work/dikt && npx tsc --noEmit` (fast). `npm run build` is vite-only (no typecheck), ~4–6 min on /mnt/c — run once at the end, in background.
- In Rust, a test that references not-yet-existing fields/functions fails at **compile time** — that is the valid RED state for those steps.
- Line references verified against `main` at `8f2ffa5`. If main moved, re-locate with the greps given per step.
- Conventional commits (repo uses semantic-release on main — work on a branch).

---

### Task 0: Branch + baselines

- [ ] **Step 0.1:**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && git checkout -b feat/meeting-summary-model-config && npx tsc --noEmit
```
Expected: branch created; tsc clean.

- [ ] **Step 0.2:**

```bash
cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test 2>&1 | tail -5
```
Expected: all tests pass (baseline ~82 tests).

---

### Task 1: Rust settings — `summary_*` fields + map-only encrypted persistence

**Files:**
- Modify: `src-tauri/src/settings.rs` (struct ~:20-56, defaults ~:58, Default impl ~:155, StoredSettings ~:118-146, load destructure/apply ~:209-268, save ~:288-325, `store_encrypted_api_key_fallback` ~:458-506, `default_stored_settings` ~:620, tests ~:645)

- [ ] **Step 1.1: Write the failing serde-default test** — append inside `mod tests` (after `meeting_hotkey_keeps_custom_value`, ~:712):

```rust
    #[test]
    fn legacy_settings_default_summary_fields() {
        let legacy_json = r#"{
      "provider": "groq",
      "base_url": "https://api.groq.com/openai/v1",
      "model": "whisper-large-v3-turbo",
      "hotkey": "CommandOrControl+Space"
    }"#;

        let parsed: StoredSettings = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(parsed.summary_provider, "groq");
        assert_eq!(parsed.summary_base_url, "https://api.groq.com/openai/v1");
        assert_eq!(parsed.summary_model, "openai/gpt-oss-120b");
        assert!(parsed.encrypted_summary_provider_api_keys.is_empty());
    }
```

- [ ] **Step 1.2: Run to verify RED (compile error — fields don't exist)**

```bash
cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test legacy_settings_default_summary 2>&1 | tail -8
```
Expected: FAIL — `no field summary_provider on type StoredSettings`.

- [ ] **Step 1.3: Add fields + defaults.**

(a) In `AppSettings` (after `provider_api_keys`, ~:49):
```rust
    #[serde(default = "default_summary_provider")]
    pub summary_provider: String,
    #[serde(default = "default_summary_base_url")]
    pub summary_base_url: String,
    #[serde(default = "default_summary_model")]
    pub summary_model: String,
    #[serde(default)]
    pub summary_api_key: String,
    #[serde(default)]
    pub summary_provider_api_keys: HashMap<String, String>,
```

(b) Default fns (next to `default_provider()`, ~:58):
```rust
fn default_summary_provider() -> String {
    "groq".to_string()
}

fn default_summary_base_url() -> String {
    "https://api.groq.com/openai/v1".to_string()
}

fn default_summary_model() -> String {
    "openai/gpt-oss-120b".to_string()
}
```

(c) In `StoredSettings` (after `encrypted_provider_api_keys`, ~:146):
```rust
    #[serde(default = "default_summary_provider")]
    summary_provider: String,
    #[serde(default = "default_summary_base_url")]
    summary_base_url: String,
    #[serde(default = "default_summary_model")]
    summary_model: String,
    #[serde(default)]
    encrypted_summary_provider_api_keys: HashMap<String, String>,
```

(d) In `impl Default for AppSettings` (~:155, after `provider_api_keys: HashMap::new(),`):
```rust
            summary_provider: default_summary_provider(),
            summary_base_url: default_summary_base_url(),
            summary_model: default_summary_model(),
            summary_api_key: String::new(),
            summary_provider_api_keys: HashMap::new(),
```

(e) In `default_stored_settings()` (~:620, after `encrypted_provider_api_keys: HashMap::new(),`):
```rust
        summary_provider: default_summary_provider(),
        summary_base_url: default_summary_base_url(),
        summary_model: default_summary_model(),
        encrypted_summary_provider_api_keys: HashMap::new(),
```

(f) **DRY cleanup (required for compilation):** `store_encrypted_api_key_fallback` (~:458-506) contains two inline `StoredSettings` literals identical to `default_stored_settings()`. Replace both with calls, mirroring `store_encrypted_assemblyai_api_key_fallback` (~:575-582):
```rust
fn store_encrypted_api_key_fallback(api_key: &str) -> Result<(), String> {
    let path = settings_path()?;
    let mut stored = if let Ok(contents) = fs::read_to_string(&path) {
        serde_json::from_str::<StoredSettings>(&contents)
            .unwrap_or_else(|_| default_stored_settings())
    } else {
        default_stored_settings()
    };

    stored.encrypted_api_key = Some(encrypt_api_key(api_key));
    // ... keep the existing write-out tail of the function unchanged ...
```

- [ ] **Step 1.4: Wire load.** In `load_settings`:

(a) Add the four names to the `let StoredSettings { ... } = stored;` destructure (~:209-230, after `encrypted_provider_api_keys`):
```rust
                    summary_provider,
                    summary_base_url,
                    summary_model,
                    encrypted_summary_provider_api_keys,
```

(b) Apply them (after `settings.modes = modes;` ~:248):
```rust
                settings.summary_provider = summary_provider;
                settings.summary_base_url = summary_base_url;
                settings.summary_model = summary_model;
```

(c) Decrypt the map (right after the existing `encrypted_provider_api_keys` decrypt loop ~:249-253):
```rust
                for (provider, encrypted) in encrypted_summary_provider_api_keys {
                    if let Some(decrypted) = decrypt_api_key(&encrypted) {
                        settings.summary_provider_api_keys.insert(provider, decrypted);
                    }
                }
```

(d) Derive the active summary key (after the transcription `api_key` mirror block ends ~:268, before the assemblyai block):
```rust
    if let Some(summary_key) = settings
        .summary_provider_api_keys
        .get(&settings.summary_provider)
        .cloned()
    {
        settings.summary_api_key = summary_key;
    }
```

- [ ] **Step 1.5: Wire save.** In `save_settings`:

(a) After the existing transcription mirror+encrypt blocks (~:288-302):
```rust
    let mut summary_provider_api_keys = settings.summary_provider_api_keys.clone();
    if settings.summary_api_key.trim().is_empty() {
        summary_provider_api_keys.remove(&settings.summary_provider);
    } else {
        summary_provider_api_keys.insert(
            settings.summary_provider.clone(),
            settings.summary_api_key.clone(),
        );
    }

    let mut encrypted_summary_provider_api_keys = HashMap::new();
    for (provider, api_key) in summary_provider_api_keys {
        if api_key.trim().is_empty() {
            continue;
        }
        encrypted_summary_provider_api_keys.insert(provider, encrypt_api_key(&api_key));
    }
```

(b) In the `StoredSettings` literal (~:304, after `encrypted_provider_api_keys,`):
```rust
        summary_provider: settings.summary_provider.clone(),
        summary_base_url: settings.summary_base_url.clone(),
        summary_model: settings.summary_model.clone(),
        encrypted_summary_provider_api_keys,
```

- [ ] **Step 1.6: Run to verify GREEN (whole settings module)**

```bash
cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test settings 2>&1 | tail -8
```
Expected: PASS incl. `legacy_settings_default_summary_fields`; zero warnings about unused fields.

- [ ] **Step 1.7: Commit**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && git add src-tauri/src/settings.rs && git commit -m "feat(settings): add summary model provider settings"
```

---

### Task 2: TypeScript types + curated model lists

**Files:**
- Modify: `src/types.ts` (`Settings`, ~:20-41)
- Modify: `src/constants.ts`

- [ ] **Step 2.1:** In `src/types.ts`, after `provider_api_keys: Partial<Record<Provider, string>>;` (~:37):
```ts
  summary_provider: Provider;
  summary_base_url: string;
  summary_model: string;
  summary_api_key: string;
  summary_provider_api_keys: Partial<Record<Provider, string>>;
```

- [ ] **Step 2.2:** In `src/constants.ts`, after the `PROVIDERS` constant (~:26), add (MUST be before `DEFAULT_SETTINGS`):
```ts
// Curated "thinking" models for meeting summaries — verified against the live
// Groq/OpenAI model APIs on 2026-06-10 (see spec §11.3). First entry = default.
export const SUMMARY_MODELS: Record<Provider, string[]> = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b'],
  openai: ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4', 'gpt-5.5'],
  custom: []
};
```
And inside `DEFAULT_SETTINGS` (after `provider_api_keys: {},`):
```ts
  summary_provider: 'groq',
  summary_base_url: PROVIDERS.groq.base_url,
  summary_model: SUMMARY_MODELS.groq[0],
  summary_api_key: '',
  summary_provider_api_keys: {},
```

- [ ] **Step 2.3: Verify**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && npx tsc --noEmit
```
Expected: clean (the new fields are additive; `DEFAULT_SETTINGS` satisfies the extended type).

- [ ] **Step 2.4: Commit**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && git add src/types.ts src/constants.ts && git commit -m "feat(ui): add summary model settings types and curated model lists"
```

---

### Task 3: `resolve_summary_config` (TDD; `resolve_groq_key` stays until Task 5)

**Files:**
- Modify: `src-tauri/src/meeting/summarize.rs` (fn area ~:93-112; tests ~:218+)

- [ ] **Step 3.1: Write failing tests** — append inside `mod tests`. The existing `settings_with` helper (~:223) stays; add a summary-field mutator beside it:

```rust
    fn with_summary(
        mut settings: AppSettings,
        provider: &str,
        api_key: &str,
        map_key: Option<&str>,
    ) -> AppSettings {
        settings.summary_provider = provider.to_string();
        settings.summary_api_key = api_key.to_string();
        settings.summary_provider_api_keys.clear();
        if let Some(key) = map_key {
            settings
                .summary_provider_api_keys
                .insert(provider.to_string(), key.to_string());
        }
        settings
    }

    #[test]
    fn resolve_summary_config_prefers_explicit_summary_key() {
        let settings = with_summary(
            settings_with("openai", "active-key", Some("legacy-groq")),
            "openai",
            "summary-key",
            Some("map-key"),
        );
        let config = resolve_summary_config(&settings).unwrap();
        assert_eq!(config.api_key, "summary-key");
        assert_eq!(config.provider, "openai");
    }

    #[test]
    fn resolve_summary_config_falls_back_to_summary_map() {
        let settings = with_summary(
            settings_with("openai", "active-key", None),
            "openai",
            "  ",
            Some("map-key"),
        );
        assert_eq!(resolve_summary_config(&settings).unwrap().api_key, "map-key");
    }

    #[test]
    fn resolve_summary_config_uses_legacy_groq_map_when_summary_unset() {
        let settings = with_summary(
            settings_with("openai", "openai-key", Some("legacy-groq")),
            "groq",
            "",
            None,
        );
        assert_eq!(
            resolve_summary_config(&settings).unwrap().api_key,
            "legacy-groq"
        );
    }

    #[test]
    fn resolve_summary_config_uses_legacy_active_key_only_when_groq_active() {
        let settings = with_summary(settings_with("groq", "active-groq", None), "groq", "", None);
        assert_eq!(
            resolve_summary_config(&settings).unwrap().api_key,
            "active-groq"
        );
    }

    #[test]
    fn resolve_summary_config_denies_legacy_fallback_for_other_providers() {
        // OpenAI summary provider must NOT borrow groq/active keys.
        let settings = with_summary(
            settings_with("groq", "active-groq", Some("legacy-groq")),
            "openai",
            "",
            None,
        );
        assert!(resolve_summary_config(&settings).is_err());
    }

    #[test]
    fn resolve_summary_config_defaults_blank_base_url_and_model_per_provider() {
        let mut settings = with_summary(
            settings_with("groq", "k", None),
            "openai",
            "summary-key",
            None,
        );
        settings.summary_base_url = "  ".to_string();
        settings.summary_model = String::new();
        let config = resolve_summary_config(&settings).unwrap();
        assert_eq!(config.base_url, "https://api.openai.com/v1");
        assert_eq!(config.model, "gpt-5.4-mini");
    }

    #[test]
    fn resolve_summary_config_rejects_blank_custom_config() {
        let mut settings = with_summary(
            settings_with("groq", "k", None),
            "custom",
            "summary-key",
            None,
        );
        settings.summary_base_url = String::new();
        settings.summary_model = "some-model".to_string();
        assert!(resolve_summary_config(&settings).unwrap_err().contains("base URL"));
    }

    #[test]
    fn resolve_summary_config_defaults_blank_groq_base_url_and_model() {
        let mut settings = with_summary(
            settings_with("openai", "k", None),
            "groq",
            "summary-key",
            None,
        );
        settings.summary_base_url = String::new();
        settings.summary_model = "  ".to_string();
        let config = resolve_summary_config(&settings).unwrap();
        assert_eq!(config.base_url, "https://api.groq.com/openai/v1");
        assert_eq!(config.model, "openai/gpt-oss-120b");
    }

    #[test]
    fn resolve_summary_config_rejects_blank_custom_model() {
        let mut settings = with_summary(
            settings_with("groq", "k", None),
            "custom",
            "summary-key",
            None,
        );
        settings.summary_base_url = "http://localhost:11434/v1".to_string();
        settings.summary_model = String::new();
        assert!(resolve_summary_config(&settings).is_err());
    }
```

- [ ] **Step 3.2: Run to verify RED**

```bash
cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test resolve_summary_config 2>&1 | tail -8
```
Expected: FAIL — `cannot find function resolve_summary_config`.

- [ ] **Step 3.3: Implement.** In `summarize.rs`, below the constants (~:18), add:

```rust
const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_OPENAI_SUMMARY_MODEL: &str = "gpt-5.4-mini";

#[derive(Debug, Clone)]
pub struct SummaryConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}
```

And below `resolve_groq_key` (~:112):

```rust
pub fn resolve_summary_config(settings: &AppSettings) -> Result<SummaryConfig, String> {
    let provider = {
        let trimmed = settings.summary_provider.trim();
        if trimmed.is_empty() {
            "groq".to_string()
        } else {
            trimmed.to_string()
        }
    };

    let api_key = non_empty(&settings.summary_api_key)
        .or_else(|| {
            settings
                .summary_provider_api_keys
                .get(&provider)
                .and_then(|key| non_empty(key))
        })
        .or_else(|| {
            if provider != "groq" {
                return None;
            }
            // v1 legacy fallback, verbatim semantics.
            settings
                .provider_api_keys
                .get("groq")
                .and_then(|key| non_empty(key))
                .or_else(|| {
                    if settings.provider == "groq" {
                        non_empty(&settings.api_key)
                    } else {
                        None
                    }
                })
        })
        .ok_or_else(|| {
            "Add an API key under Meetings → AI Summary to generate meeting summaries."
                .to_string()
        })?;

    let base_url = match non_empty(&settings.summary_base_url) {
        Some(url) => url,
        None => match provider.as_str() {
            "groq" => GROQ_BASE_URL.to_string(),
            "openai" => DEFAULT_OPENAI_BASE_URL.to_string(),
            _ => {
                return Err("Set a base URL and model under Meetings → AI Summary.".to_string())
            }
        },
    };
    let model = match non_empty(&settings.summary_model) {
        Some(model) => model,
        None => match provider.as_str() {
            "groq" => MODEL.to_string(),
            "openai" => DEFAULT_OPENAI_SUMMARY_MODEL.to_string(),
            _ => {
                return Err("Set a base URL and model under Meetings → AI Summary.".to_string())
            }
        },
    };

    Ok(SummaryConfig {
        provider,
        base_url,
        model,
        api_key,
    })
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
```

- [ ] **Step 3.4: Run to verify GREEN**

```bash
cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test summar 2>&1 | tail -8
```
Expected: all summary tests pass (old `resolve_groq_key` tests still present and green).

- [ ] **Step 3.5: Commit**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && git add src-tauri/src/meeting/summarize.rs && git commit -m "feat(meeting): resolve summary provider config with legacy fallback"
```

---

### Task 4: Provider/model-aware `request_body` (TDD)

**Files:**
- Modify: `src-tauri/src/meeting/summarize.rs` (`request_body` ~:136-148; its call in `run` ~:193; `TEMPERATURE` const ~:15; tests)

- [ ] **Step 4.1: Write failing row tests** — append inside `mod tests`, and DELETE the old `request_body_uses_locked_model_and_params` test (~:327-335, superseded):

```rust
    #[test]
    fn request_body_groq_gpt_oss_keeps_v1_reasoning_params() {
        let body = request_body("groq", "openai/gpt-oss-120b", "transcript");
        assert_eq!(body["model"], "openai/gpt-oss-120b");
        assert_eq!(body["messages"][1]["content"], "transcript");
        assert_eq!(body["temperature"], 0.3);
        assert_eq!(body["max_completion_tokens"], 8_192);
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["include_reasoning"], false);
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn request_body_groq_qwen3_disables_thinking() {
        // Probe 6/8 (spec §11.3): default leaks <think> into content; "none" is clean.
        let body = request_body("groq", "qwen/qwen3-32b", "t");
        assert_eq!(body["reasoning_effort"], "none");
        assert!(body.get("include_reasoning").is_none());
        assert_eq!(body["temperature"], 0.3);
        assert_eq!(body["max_completion_tokens"], 8_192);
    }

    #[test]
    fn request_body_groq_other_models_omit_reasoning_params() {
        // Probe 5: llama-3.3 rejects reasoning_effort outright.
        let body = request_body("groq", "llama-3.3-70b-versatile", "t");
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("include_reasoning").is_none());
    }

    #[test]
    fn request_body_openai_omits_temperature_and_include_reasoning() {
        // Probes 3 & 7: include_reasoning = unknown param; temperature rejected on 5.4-mini.
        let body = request_body("openai", "gpt-5.4-mini", "t");
        assert!(body.get("temperature").is_none());
        assert!(body.get("include_reasoning").is_none());
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["max_completion_tokens"], 8_192);
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn request_body_custom_uses_broadest_compat_params() {
        let body = request_body("custom", "llama3:70b", "t");
        assert_eq!(body["temperature"], 0.3);
        assert_eq!(body["max_tokens"], 8_192);
        assert!(body.get("max_completion_tokens").is_none());
        assert!(body.get("reasoning_effort").is_none());
    }
```

- [ ] **Step 4.2: Run to verify RED**

```bash
cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test request_body 2>&1 | tail -8
```
Expected: FAIL — `request_body` takes 1 argument.

- [ ] **Step 4.3: Implement.**

(a) Change the const (~:15) from `f32` to `f64` so test literals compare exactly (f32→JSON would serialize as `0.30000001192…`):
```rust
const TEMPERATURE: f64 = 0.3;
```

(b) Replace `request_body` (~:136-148):
```rust
fn request_body(provider: &str, model: &str, transcript_text: &str) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SUMMARY_SYSTEM_PROMPT },
            { "role": "user", "content": transcript_text }
        ]
    });
    let params = body.as_object_mut().expect("request body is a JSON object");
    let model_lower = model.to_ascii_lowercase();
    // Per-provider/per-model matrix, live-verified 2026-06-10 (spec §11.6).
    match provider {
        "openai" => {
            params.insert("max_completion_tokens".into(), MAX_COMPLETION_TOKENS.into());
            params.insert("reasoning_effort".into(), "low".into());
        }
        "groq" => {
            params.insert("temperature".into(), TEMPERATURE.into());
            params.insert("max_completion_tokens".into(), MAX_COMPLETION_TOKENS.into());
            if model_lower.contains("gpt-oss") {
                params.insert("reasoning_effort".into(), "low".into());
                params.insert("include_reasoning".into(), false.into());
            } else if model_lower.contains("qwen3") {
                params.insert("reasoning_effort".into(), "none".into());
            }
        }
        _ => {
            params.insert("temperature".into(), TEMPERATURE.into());
            params.insert("max_tokens".into(), MAX_COMPLETION_TOKENS.into());
        }
    }
    body
}
```

(c) Update the single call site in `run()` (~:193) to keep current behavior until Task 5:
```rust
        .json(&request_body("groq", MODEL, &transcript_text))
```

- [ ] **Step 4.4: Run to verify GREEN**

```bash
cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test request_body 2>&1 | tail -8
```
Expected: 5 PASS.

- [ ] **Step 4.5: Commit**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && git add src-tauri/src/meeting/summarize.rs && git commit -m "feat(meeting): provider-aware summary request body"
```

---

### Task 5: Route `run()` through `SummaryConfig`; neutral errors + rate-limit hint; switch command; delete `resolve_groq_key`

**Files:**
- Modify: `src-tauri/src/meeting/summarize.rs` (`run` ~:163-216, `parse_summary_content` ~:150-161, old fn/tests removal)
- Modify: `src-tauri/src/commands.rs` (`generate_meeting_summary` ~:260-271)

- [ ] **Step 5.1: Write failing hint tests** — append inside `mod tests`:

```rust
    #[test]
    fn rate_limit_hint_appends_on_429() {
        let message = with_rate_limit_hint(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            "{}",
            "Summary API error (groq) 429: {}".to_string(),
        );
        assert!(message.contains("try a smaller model or a different provider"));
    }

    #[test]
    fn rate_limit_hint_appends_on_rate_limit_body() {
        let message = with_rate_limit_hint(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"code":"RATE_LIMIT_EXCEEDED"}}"#,
            "base".to_string(),
        );
        assert!(message.contains("Meetings → AI Summary"));
    }

    #[test]
    fn rate_limit_hint_leaves_other_errors_unchanged() {
        let message =
            with_rate_limit_hint(reqwest::StatusCode::UNAUTHORIZED, "{}", "base".to_string());
        assert_eq!(message, "base");
    }
```

- [ ] **Step 5.2: RED**

```bash
cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test rate_limit_hint 2>&1 | tail -6
```
Expected: FAIL — `cannot find function with_rate_limit_hint`.

- [ ] **Step 5.3: Implement the v2 `run()` + hint + neutral strings.**

(a) Add near `parse_summary_content`:
```rust
fn with_rate_limit_hint(status: reqwest::StatusCode, body: &str, message: String) -> String {
    let rate_limited = status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || body.to_ascii_lowercase().contains("rate_limit");
    if rate_limited {
        format!("{message} Rate or token limit hit — try a smaller model or a different provider under Meetings → AI Summary.")
    } else {
        message
    }
}
```

(b) Provider-neutral strings in `parse_summary_content` (~:150-161): `"Failed to parse Groq response: {error}"` → `"Failed to parse summary response: {error}"`; `"Groq response did not include summary content."` → `"Summary response did not include content."`. Update the two parse tests' expectations only if they assert message text (they don't — they assert `is_err()`/`unwrap()`).

(c) Replace `run`'s signature and the affected lines (~:163-216):
```rust
pub async fn run(
    config: SummaryConfig,
    id: String,
    detail: MeetingDetail,
) -> Result<MeetingSummary, String> {
```
- POST line: `client.post(format!("{}/chat/completions", config.base_url.trim_end_matches('/')))`
- auth: `.bearer_auth(&config.api_key)`
- body: `.json(&request_body(&config.provider, &config.model, &transcript_text))`
- error branch:
```rust
    if !status.is_success() {
        return Err(with_rate_limit_hint(
            status,
            &response_body,
            format!(
                "Summary API error ({}) {status}: {response_body}",
                config.provider
            ),
        ));
    }
```
- `MeetingSummary` literal: `model: config.model.clone(), provider: config.provider.clone(),` (rest unchanged).

(d) DELETE `resolve_groq_key` (~:93-112) and its four tests (`resolve_groq_key_prefers_saved_groq_provider_key`, `resolve_groq_key_falls_back_to_api_key_only_when_groq_is_active`, `resolve_groq_key_rejects_api_key_of_other_providers`, `resolve_groq_key_rejects_blank_keys`) — fully superseded by Task 3's tests. Keep `MODEL` (now the groq default used by `resolve_summary_config`).

(e) In `src-tauri/src/commands.rs` (~:260-271):
```rust
#[tauri::command]
pub async fn generate_meeting_summary(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::meeting::types::MeetingSummary, String> {
    let settings = state.manager.get_settings()?;
    let config = crate::meeting::summarize::resolve_summary_config(&settings)?;
    let detail = state.meeting_manager.get(&id)?;
    let summary = crate::meeting::summarize::run(config, id, detail).await?;
    let _ = app.emit("meetings-updated", ());
    Ok(summary)
}
```

- [ ] **Step 5.4: Full Rust suite GREEN (catches every missed call site)**

```bash
cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test 2>&1 | tail -6
```
Expected: all pass; `cargo.exe build` not needed separately (tests compile the bin).

- [ ] **Step 5.5: Commit**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && git add src-tauri/src/meeting/summarize.rs src-tauri/src/commands.rs && git commit -m "feat(meeting): route summaries through configured provider"
```

---

### Task 6: Meeting config panel → `Capture | Transcription | AI Summary` tabs

**Files:**
- Modify: `src/components/Settings/SettingsPage.tsx` (`GroqIcon` ~:22, `OpenAIIcon` ~:28 — export only)
- Modify: `src/components/Settings/MeetingsPage.tsx` (config panel ~:300-460; type defs ~:57; signals ~:163)

- [ ] **Step 6.1:** In `SettingsPage.tsx`, change `const GroqIcon =` → `export const GroqIcon =` and `const OpenAIIcon =` → `export const OpenAIIcon =`. No other change.

- [ ] **Step 6.2:** In `MeetingsPage.tsx`:

(a) After `type TranscriptTab = 'transcript' | 'summary';` (~:57):
```ts
type ConfigTab = 'capture' | 'transcription' | 'summary';

const CONFIG_TABS: { value: ConfigTab; label: string }[] = [
  { value: 'capture', label: 'Capture' },
  { value: 'transcription', label: 'Transcription' },
  { value: 'summary', label: 'AI Summary' },
];
```

(b) Next to the `activeTab` signal (~:172):
```ts
const [configTab, setConfigTab] = createSignal<ConfigTab>('capture');
```

(c) Restructure the panel (~:300-483). Replace the `<div class="mb-3"><h2 …>Capture Configuration</h2></div>` heading with nothing (the tabs replace it), and reorganize the existing `<div class="space-y-3">` so it reads:

```tsx
<div class="space-y-3">
  {/* 1. Consent banner — stays ABOVE the tabs (unchanged JSX, move as-is) */}
  <Show when={!props.settings().meeting_consent_acknowledged}>
    {/* existing amber consent block, verbatim */}
  </Show>

  {/* 2. Tab strip */}
  <div class="flex items-center gap-1 border-b border-white/5">
    <For each={CONFIG_TABS}>
      {(tab) => (
        <button
          type="button"
          onClick={() => setConfigTab(tab.value)}
          class={`px-3 pb-2 border-b-2 text-[11px] font-mono uppercase tracking-wider transition-colors cursor-pointer ${
            configTab() === tab.value
              ? 'border-primary text-primary'
              : 'border-transparent text-zinc-500 hover:text-zinc-200'
          }`}
        >
          {tab.label}
        </button>
      )}
    </For>
  </div>

  {/* 3. Capture tab: hotkey+video grid, mic+system grid, toggle grid, AND the three
        device-warning <Show> blocks (no-loopback note, devices().message, empty-device
        error — currently ~:469-481) — all existing JSX moved verbatim */}
  <Show when={configTab() === 'capture'}>
    <div class="space-y-3">{/* …existing blocks… */}</div>
  </Show>

  {/* 4. Transcription tab: AssemblyAI key field moved verbatim */}
  <Show when={configTab() === 'transcription'}>
    <div class="space-y-3">{/* …existing AssemblyAI div… */}</div>
  </Show>

  {/* 5. AI Summary tab — Task 7 */}
</div>
```
`For` is already imported from solid-js (~:1).

- [ ] **Step 6.3: Verify + eyeball**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && npx tsc --noEmit
```
Expected: clean. (Unused-import warnings are not emitted — tsconfig has no `noUnusedLocals`.)

- [ ] **Step 6.4: Commit**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && git add src/components/Settings/SettingsPage.tsx src/components/Settings/MeetingsPage.tsx && git commit -m "feat(ui): split meeting config into capture/transcription/summary tabs"
```

---

### Task 7: AI Summary tab — provider cards, base URL, model, key, switch logic

**Files:**
- Modify: `src/components/Settings/MeetingsPage.tsx`

- [ ] **Step 7.1: Imports.** Extend the existing import lines:
- lucide (~:4-23): add `Eye,` and `EyeOff,`
- types (~:24): `import type { MeetingDetail, MeetingDevices, MeetingMeta, Provider, Settings } from '../../types';`
- new lines after the Select import (~:27):
```ts
import { PROVIDERS, SUMMARY_MODELS } from '../../constants';
import { GroqIcon, OpenAIIcon } from './SettingsPage';
import type { JSX } from 'solid-js';
```

- [ ] **Step 7.2: Module-level option list + model memory** (below `CONFIG_TABS`):
```ts
type SummaryProviderOption = {
  value: Provider;
  label: string;
  icon?: string;
  iconComponent?: (props: { class?: string }) => JSX.Element;
};

const SUMMARY_PROVIDER_OPTIONS: SummaryProviderOption[] = [
  { value: 'groq', label: 'Groq', iconComponent: GroqIcon },
  { value: 'openai', label: 'OpenAI', iconComponent: OpenAIIcon },
  { value: 'custom', label: 'Custom', icon: 'dns' },
];

// Session-scoped model stash per provider (mirrors providerModelMemory in SettingsPage).
const summaryModelMemory: Partial<Record<Provider, string>> = {};
```

- [ ] **Step 7.3: Component-level state + handlers** (next to `configTab`):
```ts
const [showSummaryKey, setShowSummaryKey] = createSignal(false);

const summaryModelOptions = () =>
  SUMMARY_MODELS[props.settings().summary_provider].map((model) => ({ value: model, label: model }));

const onSummaryProviderChange = (provider: Provider) => {
  if (provider === props.settings().summary_provider) return;
  applyChange((current) => {
    const previous = current.summary_provider;
    const stashedKeys = { ...current.summary_provider_api_keys };
    if (current.summary_api_key.trim()) {
      stashedKeys[previous] = current.summary_api_key;
    } else {
      delete stashedKeys[previous];
    }
    summaryModelMemory[previous] = current.summary_model;

    // Restore this provider's summary key; if none, prefill from the
    // transcription-side key for the same provider (spec §11.8 step 2).
    const restoredKey = stashedKeys[provider]?.trim()
      ? (stashedKeys[provider] as string)
      : (current.provider_api_keys[provider] ?? '');

    return {
      ...current,
      summary_provider: provider,
      summary_base_url: PROVIDERS[provider].base_url,
      summary_model: summaryModelMemory[provider] ?? SUMMARY_MODELS[provider][0] ?? '',
      summary_api_key: restoredKey,
      summary_provider_api_keys: stashedKeys,
    };
  });
};
```
(`applyChange` ~:215 already persists via `onSaveSettings`.)

- [ ] **Step 7.4: Tab JSX** — fill Task 6's slot 5:
```tsx
<Show when={configTab() === 'summary'}>
  <div class="space-y-3">
    <div class="grid grid-cols-3 gap-2">
      <For each={SUMMARY_PROVIDER_OPTIONS}>
        {(option) => {
          const isActive = () => props.settings().summary_provider === option.value;
          return (
            <button
              type="button"
              onClick={() => onSummaryProviderChange(option.value)}
              class={`cursor-pointer relative p-3 rounded-xl border transition-colors flex flex-col items-center justify-center gap-1.5 ${
                isActive()
                  ? 'border-primary bg-primary/5'
                  : 'border-white/10 bg-surface-dark hover:border-white/20 hover:bg-white/[0.03]'
              }`}
            >
              {option.iconComponent
                ? option.iconComponent({ class: `w-5 h-5 ${isActive() ? 'text-primary' : 'text-gray-400'}` })
                : <span class={`material-symbols-outlined text-xl ${isActive() ? 'text-primary' : 'text-gray-400'}`}>{option.icon}</span>}
              <span class={`font-medium text-xs ${isActive() ? 'text-white' : 'text-gray-300'}`}>{option.label}</span>
            </button>
          );
        }}
      </For>
    </div>

    <div>
      <label class="text-xs text-gray-500 font-medium ml-1">Base URL</label>
      <input
        type="text"
        value={props.settings().summary_base_url}
        onInput={(e) =>
          props.setSettings((current) => ({
            ...current,
            summary_base_url: (e.target as HTMLInputElement).value,
          }))
        }
        onBlur={() => void props.onSaveSettings()}
        placeholder="https://api.example.com/v1"
        class="mt-1.5 w-full bg-input-bg border border-white/15 rounded-lg py-1.5 px-3 text-sm font-mono text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
      />
    </div>

    <div>
      <label class="text-xs text-gray-500 font-medium ml-1">Model</label>
      <Show
        when={props.settings().summary_provider !== 'custom'}
        fallback={
          <input
            type="text"
            value={props.settings().summary_model}
            onInput={(e) =>
              props.setSettings((current) => ({
                ...current,
                summary_model: (e.target as HTMLInputElement).value,
              }))
            }
            onBlur={() => void props.onSaveSettings()}
            placeholder="model-name"
            class="mt-1.5 w-full bg-input-bg border border-white/15 rounded-lg py-1.5 px-3 text-sm font-mono text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
          />
        }
      >
        <Select
          value={props.settings().summary_model}
          options={summaryModelOptions()}
          class="mt-1.5 px-3 py-1.5"
          onChange={(value) => applyChange((current) => ({ ...current, summary_model: value }))}
        />
      </Show>
    </div>

    <div>
      <label class="text-xs text-gray-500 font-medium ml-1">API key</label>
      <div class="relative mt-1.5">
        <input
          type={showSummaryKey() ? 'text' : 'password'}
          value={props.settings().summary_api_key}
          onInput={(e) =>
            props.setSettings((current) => ({
              ...current,
              summary_api_key: (e.target as HTMLInputElement).value,
            }))
          }
          onBlur={() => void props.onSaveSettings()}
          placeholder="API key for meeting summaries"
          class="w-full bg-input-bg border border-white/15 rounded-lg py-1.5 pl-3 pr-10 text-sm font-mono text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
        />
        <button
          type="button"
          onClick={() => setShowSummaryKey((value) => !value)}
          class="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 transition-colors cursor-pointer"
          title={showSummaryKey() ? 'Hide key' : 'Show key'}
        >
          <Show when={showSummaryKey()} fallback={<Eye size={15} />}>
            <EyeOff size={15} />
          </Show>
        </button>
      </div>
      <p class="mt-1 text-[11px] text-zinc-600">
        Used only for meeting summaries. Transcription settings are unaffected.
      </p>
    </div>
  </div>
</Show>
```

- [ ] **Step 7.5: Verify**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 7.6: Commit**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && git add src/components/Settings/MeetingsPage.tsx && git commit -m "feat(ui): add AI summary provider configuration tab"
```

---

### Task 8: Provider-aware SummaryPanel copy

**Files:**
- Modify: `src/components/Settings/MeetingsPage.tsx` (SummaryPanel props/strings; call site ~:732-737)

- [ ] **Step 8.1:** Add `summaryModel: string;` to `SummaryPanel`'s props type, and pass it at the call site:
```tsx
<SummaryPanel
  meeting={meeting()}
  onGenerateSummary={props.onGenerateSummary}
  generating={Boolean(props.summaryGenerating()[meeting().meta.id])}
  error={props.summaryErrors()[meeting().meta.id] ?? null}
  summaryModel={props.settings().summary_model}
/>
```

- [ ] **Step 8.2:** Replace the two hardcoded strings (spec §11.8 supersession):
- Subtitle (~:895) `Generated with GPT-OSS-120B on Groq from the meeting transcript.` →
```tsx
Generated from the meeting transcript with {summary()?.model ?? props.summaryModel}.
```
- Loading copy (~:938) `GPT-OSS-120B is analyzing the transcript on Groq.` →
```tsx
{props.summaryModel} is analyzing the transcript.
```

- [ ] **Step 8.3: Verify + commit**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && npx tsc --noEmit && git add src/components/Settings/MeetingsPage.tsx && git commit -m "feat(ui): make summary panel copy provider-aware"
```

---

### Task 9: Full verification

- [ ] **Step 9.1: Full Rust suite**

```bash
cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test 2>&1 | tail -6
```
Expected: all pass (baseline + ~18 new, − 5 deleted).

- [ ] **Step 9.2: Frontend build (background — vite ~4–6 min on /mnt/c)**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && npm run build
```
Expected: vite build succeeds.

- [ ] **Step 9.3: Manual smoke (requires Windows app run)** — launch the dev app, then:
1. Meetings → config shows `Capture | Transcription | AI Summary` tabs; consent banner above tabs when unacknowledged.
2. AI Summary tab: Groq selected by default, model `openai/gpt-oss-120b`. The key field MAY be empty on first open — that is correct (prefill is switch-scoped, §11.8 step 2; generation still works via the legacy fallback, item 5). Switching to another provider and back to Groq prefills from the transcription-side Groq key.
3. Switch to OpenAI: base URL flips to `https://api.openai.com/v1`, model to `gpt-5.4-mini`, key prefills from the OpenAI transcription key if present.
4. Generate a summary on a transcribed meeting via OpenAI → succeeds; footer shows the OpenAI model id; loading copy names the configured model.
5. Clear all summary keys, set provider Groq with a transcription-side Groq key configured → generation still works (legacy fallback).
6. Restart the app → summary provider/model/key survive (persistence round-trip).
7. Optional (spec §11.9 "generate on each provider"): if a local OpenAI-compatible endpoint is available (Ollama/LM Studio), point Custom at it and generate once; otherwise note the skip in the PR description.

- [ ] **Step 9.4:** Hand off to superpowers:finishing-a-development-branch (merge/PR decision is the maintainer's).

---

## Out of scope (do not add)

- Temperature/reasoning-effort UI knobs; per-meeting model override; "Test & Save" for summary keys; chunked map-reduce summarization; any change to `CHAT_MODELS`/Modes; any DB/schema change.
