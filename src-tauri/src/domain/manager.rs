use std::sync::Mutex;

use regex::Regex;

use crate::settings::AppSettings;

use super::{
  ports::{Paster, Recorder, SettingsStore, Transcriber},
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
}

impl DictationSessionManager {
  pub fn new(
    recorder: Box<dyn Recorder>,
    settings_store: Box<dyn SettingsStore>,
    transcriber: Box<dyn Transcriber>,
    paster: Box<dyn Paster>,
  ) -> Self {
    let initial_settings = settings_store.load();
    Self {
      state: Mutex::new(DictationState::Idle),
      settings: Mutex::new(initial_settings),
      recorder,
      settings_store,
      transcriber,
      paster,
    }
  }

  pub fn get_settings(&self) -> Result<AppSettings, String> {
    Ok(
      self
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?
        .clone(),
    )
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
    let mut next_settings = self
      .settings
      .lock()
      .map_err(|_| "Settings lock poisoned".to_string())?
      .clone();
    next_settings.vocabulary = vocabulary;

    self.settings_store.save(&next_settings)?;

    let mut guard = self
      .settings
      .lock()
      .map_err(|_| "Settings lock poisoned".to_string())?;
    *guard = next_settings;
    Ok(())
  }

  pub fn start_recording<F>(&self, mut on_update: F) -> Result<(), String>
  where
    F: FnMut(DictationUpdate),
  {
    {
      let mut state = self.state.lock().map_err(|_| "State lock poisoned".to_string())?;
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
      let mut state = self.state.lock().map_err(|_| "State lock poisoned".to_string())?;
      if *state != DictationState::Recording {
        return Err("Not recording".to_string());
      }
      *state = DictationState::Transcribing;
    }

    on_update(DictationUpdate::new(DictationState::Transcribing));

    let result = async {
      let wav_data = self.recorder.stop()?;

      let settings = self
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?
        .clone();

      let prompt = build_vocabulary_prompt(&settings.vocabulary);
      let text = self
        .transcriber
        .transcribe(&settings, wav_data, prompt.as_deref())
        .await?;
      let text = apply_vocabulary_replacements(&text, &settings.vocabulary);

      {
        let _ = self.set_state(DictationState::Pasting);
      }
      on_update(DictationUpdate::new(DictationState::Pasting));

      self.paster.paste(&text)?;

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
    let mut state = self.state.lock().map_err(|_| "State lock poisoned".to_string())?;
    *state = next;
    Ok(())
  }
}

fn build_vocabulary_prompt(vocabulary: &[VocabularyEntry]) -> Option<String> {
  let words: Vec<&str> = vocabulary
    .iter()
    .filter(|entry| entry.enabled)
    .map(|entry| entry.word.trim())
    .filter(|word| !word.is_empty())
    .take(MAX_PROMPT_ENTRIES)
    .collect();

  if words.is_empty() {
    return None;
  }

  let mut prompt = String::from("Vocabulary: ");
  for word in words {
    let candidate = if prompt == "Vocabulary: " {
      format!("{prompt}{word}")
    } else {
      format!("{prompt}, {word}")
    };

    if candidate.len() > MAX_PROMPT_CHARS {
      break;
    }

    prompt = candidate;
  }

  if prompt == "Vocabulary: " {
    None
  } else {
    Some(prompt)
  }
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

#[cfg(test)]
mod tests {
  use super::{apply_vocabulary_replacements, build_vocabulary_prompt, VocabularyEntry};

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
}
