use std::io::Cursor;
use std::sync::Mutex;

use regex::Regex;

use crate::settings::AppSettings;
use crate::transcription_history::TranscriptionHistoryItem;

use super::{
    ports::{Formatter, Paster, Recorder, SettingsStore, Transcriber},
    types::{DictationState, DictationUpdate, VocabularyEntry},
};

const MAX_PROMPT_ENTRIES: usize = 50;
const MAX_PROMPT_CHARS: usize = 800;
const MAX_REPLACEMENTS_PER_ENTRY: usize = 10;

pub struct DictationSessionManager {
    state: Mutex<DictationState>,
    settings: Mutex<AppSettings>,

    recorder: Box<dyn Recorder>,
    settings_store: Box<dyn SettingsStore>,
    transcriber: Box<dyn Transcriber>,
    paster: Box<dyn Paster>,
    formatter: Box<dyn Formatter>,
}

impl DictationSessionManager {
    pub fn new(
        recorder: Box<dyn Recorder>,
        settings_store: Box<dyn SettingsStore>,
        transcriber: Box<dyn Transcriber>,
        paster: Box<dyn Paster>,
        formatter: Box<dyn Formatter>,
    ) -> Self {
        let initial_settings = settings_store.load();
        Self {
            state: Mutex::new(DictationState::Idle),
            settings: Mutex::new(initial_settings),
            recorder,
            settings_store,
            transcriber,
            paster,
            formatter,
        }
    }

    pub fn get_settings(&self) -> Result<AppSettings, String> {
        Ok(self
            .settings
            .lock()
            .map_err(|_| "Settings lock poisoned".to_string())?
            .clone())
    }

    pub fn save_settings(&self, settings: AppSettings) -> Result<(), String> {
        self.settings_store.save(&settings)?;
        let mut guard = self
            .settings
            .lock()
            .map_err(|_| "Settings lock poisoned".to_string())?;
        *guard = settings;
        Ok(())
    }

    pub fn save_vocabulary(&self, vocabulary: Vec<VocabularyEntry>) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.vocabulary = vocabulary;
        self.save_settings(settings)
    }

    pub fn start_recording<F>(&self, mut on_update: F) -> Result<(), String>
    where
        F: FnMut(DictationUpdate),
    {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "State lock poisoned".to_string())?;
            if *state != DictationState::Idle {
                return Err("Busy".to_string());
            }
            *state = DictationState::Recording;
        }

        on_update(DictationUpdate::new(DictationState::Recording));

        match self.recorder.start() {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = self.set_state(DictationState::Idle);
                on_update(DictationUpdate::new(DictationState::Error).message(e.clone()));
                Err(e)
            }
        }
    }

    pub async fn stop_and_process<F>(&self, mut on_update: F) -> Result<String, String>
    where
        F: FnMut(DictationUpdate),
    {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "State lock poisoned".to_string())?;
            if *state != DictationState::Recording {
                return Err("Not recording".to_string());
            }
            *state = DictationState::Transcribing;
        }

        on_update(DictationUpdate::new(DictationState::Transcribing));

        let result = async {
            let wav_data = self.recorder.stop()?;
            let local_duration = wav_duration_secs(&wav_data);

            let settings = self
                .settings
                .lock()
                .map_err(|_| "Settings lock poisoned".to_string())?
                .clone();

            let prompt = build_vocabulary_prompt(&settings.vocabulary);
            let transcription_result = self
                .transcriber
                .transcribe(&settings, wav_data, prompt.as_deref())
                .await?;

            let duration_secs = transcription_result.duration_secs.or(local_duration);
            let language = transcription_result.language;

            let text =
                apply_vocabulary_replacements(&transcription_result.text, &settings.vocabulary);

            let mut mode_name: Option<String> = None;
            let mut original_text: Option<String> = None;

            let active_mode = settings
                .active_mode_id
                .as_ref()
                .and_then(|mode_id| settings.modes.iter().find(|m| &m.id == mode_id));
            let text = if let Some(mode) = active_mode {
                let _ = self.set_state(DictationState::Formatting);
                on_update(DictationUpdate::new(DictationState::Formatting));
                match self
                    .formatter
                    .format(
                        &settings.base_url,
                        &settings.api_key,
                        &mode.model,
                        &mode.system_prompt,
                        &text,
                    )
                    .await
                {
                    Ok(formatted) => {
                        mode_name = Some(mode.name.clone());
                        if formatted != text {
                            original_text = Some(text);
                        }
                        formatted
                    }
                    Err(e) => {
                        eprintln!("Formatting failed, using original text: {e}");
                        text
                    }
                }
            } else {
                text
            };

            if let Err(e) = crate::transcription_history::append_item(TranscriptionHistoryItem {
                text: text.clone(),
                duration_secs,
                language,
                mode_name,
                original_text,
                ..Default::default()
            }) {
                eprintln!("Failed to save transcription history: {e}");
                crate::transcription_history::record_runtime_error(format!(
                    "Failed to save transcription history: {e}"
                ));
            }

            {
                let _ = self.set_state(DictationState::Pasting);
            }
            on_update(DictationUpdate::new(DictationState::Pasting));

            self.paster.paste(&format!("{text} "))?;
            if settings.copy_to_clipboard_on_success {
                if let Err(copy_err) = self.paster.copy(&text) {
                    eprintln!("Failed to copy transcript to clipboard: {copy_err}");
                }
            }

            {
                let _ = self.set_state(DictationState::Done);
            }
            on_update(DictationUpdate::new(DictationState::Done).text(text.clone()));

            Ok::<_, String>(text)
        }
        .await;

        // Always return to Idle at the end of a run.
        let _ = self.set_state(DictationState::Idle);

        match result {
            Ok(text) => Ok(text),
            Err(err) => {
                on_update(DictationUpdate::new(DictationState::Error).message(err.clone()));
                Err(err)
            }
        }
    }

    fn set_state(&self, next: DictationState) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        *state = next;
        Ok(())
    }
}

fn build_vocabulary_prompt(vocabulary: &[VocabularyEntry]) -> Option<String> {
    const PREFIX: &str = "Vocabulary: ";
    let mut words = Vec::new();
    let mut len = PREFIX.len();
    let enabled_words = vocabulary
        .iter()
        .filter(|entry| entry.enabled)
        .map(|entry| entry.word.trim())
        .filter(|word| !word.is_empty());
    for word in enabled_words.take(MAX_PROMPT_ENTRIES) {
        let added = if words.is_empty() { 0 } else { ", ".len() } + word.len();
        if len + added > MAX_PROMPT_CHARS {
            break;
        }
        len += added;
        words.push(word);
    }

    (!words.is_empty()).then(|| format!("{PREFIX}{}", words.join(", ")))
}

fn apply_vocabulary_replacements(text: &str, vocabulary: &[VocabularyEntry]) -> String {
    let mut result = text.to_string();

    for entry in vocabulary.iter().filter(|entry| entry.enabled) {
        if entry.word.trim().is_empty() {
            continue;
        }

        for replacement in entry.replacements.iter().take(MAX_REPLACEMENTS_PER_ENTRY) {
            let replacement = replacement.trim();
            if replacement.is_empty() {
                continue;
            }

            let pattern = build_word_boundary_pattern(replacement);
            let regex = match Regex::new(&pattern) {
                Ok(regex) => regex,
                Err(error) => {
                    eprintln!("Invalid replacement regex '{replacement}': {error}");
                    continue;
                }
            };
            result = regex.replace_all(&result, entry.word.as_str()).to_string();
        }
    }

    result
}

fn build_word_boundary_pattern(replacement: &str) -> String {
    let escaped = regex::escape(replacement);
    let starts_with_word_char = replacement.chars().next().is_some_and(is_word_char);
    let ends_with_word_char = replacement.chars().last().is_some_and(is_word_char);

    let mut pattern = String::from("(?iu)");
    if starts_with_word_char {
        pattern.push_str(r"\b");
    }
    pattern.push_str(&escaped);
    if ends_with_word_char {
        pattern.push_str(r"\b");
    }

    pattern
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

fn wav_duration_secs(data: &[u8]) -> Option<f64> {
    let reader = hound::WavReader::new(Cursor::new(data)).ok()?;
    let sample_rate = reader.spec().sample_rate;
    (sample_rate > 0).then(|| reader.duration() as f64 / sample_rate as f64)
}

#[cfg(test)]
mod tests {
    use super::{
        apply_vocabulary_replacements, build_vocabulary_prompt, wav_duration_secs, VocabularyEntry,
        MAX_PROMPT_CHARS,
    };

    #[test]
    fn build_prompt_returns_none_for_empty_vocabulary() {
        assert!(build_vocabulary_prompt(&[]).is_none());
    }

    #[test]
    fn build_prompt_uses_enabled_words_only() {
        let vocabulary = vec![
            VocabularyEntry {
                id: "1".to_string(),
                word: "Kubernetes".to_string(),
                replacements: vec!["cube and eighties".to_string()],
                enabled: true,
            },
            VocabularyEntry {
                id: "2".to_string(),
                word: "Anthropic".to_string(),
                replacements: vec!["anthropic".to_string()],
                enabled: false,
            },
        ];

        let prompt = build_vocabulary_prompt(&vocabulary).unwrap();
        assert_eq!(prompt, "Vocabulary: Kubernetes");
    }

    #[test]
    fn apply_replacements_matches_word_boundaries() {
        let vocabulary = vec![VocabularyEntry {
            id: "1".to_string(),
            word: "the".to_string(),
            replacements: vec!["teh".to_string()],
            enabled: true,
        }];

        assert_eq!(
            apply_vocabulary_replacements("teh cat, other", &vocabulary),
            "the cat, other"
        );
    }

    #[test]
    fn apply_replacements_is_case_insensitive() {
        let vocabulary = vec![VocabularyEntry {
            id: "1".to_string(),
            word: "Kubernetes".to_string(),
            replacements: vec!["cube and eighties".to_string()],
            enabled: true,
        }];

        assert_eq!(
            apply_vocabulary_replacements("CUBE AND EIGHTIES", &vocabulary),
            "Kubernetes"
        );
    }

    fn entry(word: &str) -> VocabularyEntry {
        VocabularyEntry {
            id: word.to_string(),
            word: word.to_string(),
            replacements: Vec::new(),
            enabled: true,
        }
    }

    #[test]
    fn build_prompt_joins_words_and_stops_at_char_limit() {
        let vocabulary = vec![entry(" alpha "), entry(""), entry("beta")];
        assert_eq!(
            build_vocabulary_prompt(&vocabulary).as_deref(),
            Some("Vocabulary: alpha, beta")
        );

        // 12-char prefix + 99-char words joined by ", ": 7 words fit in 800, the 8th does not.
        let long: Vec<_> = (0..20).map(|i| entry(&format!("{i:0>99}"))).collect();
        let prompt = build_vocabulary_prompt(&long).unwrap();
        assert_eq!(prompt.len(), 12 + 7 * 99 + 6 * 2);
        assert!(prompt.len() <= MAX_PROMPT_CHARS);

        assert!(build_vocabulary_prompt(&[entry(&"x".repeat(MAX_PROMPT_CHARS))]).is_none());
    }

    #[test]
    fn wav_duration_reads_hound_header() {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 8_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut wav = Vec::new();
        let mut writer = hound::WavWriter::new(std::io::Cursor::new(&mut wav), spec).unwrap();
        for _ in 0..(4_000 * 2) {
            writer.write_sample(0i16).unwrap();
        }
        writer.finalize().unwrap();
        assert_eq!(wav_duration_secs(&wav), Some(0.5));
        assert_eq!(wav_duration_secs(&wav[..20]), None);
    }
}
