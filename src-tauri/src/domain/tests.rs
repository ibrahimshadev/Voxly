use std::sync::{
  atomic::{AtomicBool, AtomicUsize, Ordering},
  Mutex,
};

use crate::settings::AppSettings;

use super::{
  manager::DictationSessionManager,
  ports::{Formatter, Paster, Recorder, SettingsStore, Transcriber},
  types::{DictationState, Mode, VocabularyEntry},
};

// ============================================================================
// Mock Implementations
// ============================================================================

#[derive(Default)]
struct MockRecorder {
  start_called: AtomicUsize,
  stop_called: AtomicUsize,
  should_fail_start: AtomicBool,
  should_fail_stop: AtomicBool,
  audio_data: Mutex<Vec<u8>>,
}

impl MockRecorder {
  fn new() -> Self {
    Self {
      audio_data: Mutex::new(vec![0u8; 100]), // Fake WAV data
      ..Default::default()
    }
  }

  fn with_start_failure() -> Self {
    let mock = Self::new();
    mock.should_fail_start.store(true, Ordering::SeqCst);
    mock
  }

  fn with_stop_failure() -> Self {
    let mock = Self::new();
    mock.should_fail_stop.store(true, Ordering::SeqCst);
    mock
  }
}

impl Recorder for MockRecorder {
  fn start(&self) -> Result<(), String> {
    self.start_called.fetch_add(1, Ordering::SeqCst);
    if self.should_fail_start.load(Ordering::SeqCst) {
      return Err("Mock start failure".to_string());
    }
    Ok(())
  }

  fn stop(&self) -> Result<Vec<u8>, String> {
    self.stop_called.fetch_add(1, Ordering::SeqCst);
    if self.should_fail_stop.load(Ordering::SeqCst) {
      return Err("Mock stop failure".to_string());
    }
    Ok(self.audio_data.lock().unwrap().clone())
  }
}

struct MockSettingsStore {
  settings: Mutex<AppSettings>,
  save_called: AtomicUsize,
}

impl MockSettingsStore {
  fn new() -> Self {
    Self {
      settings: Mutex::new(AppSettings::default()),
      save_called: AtomicUsize::new(0),
    }
  }

  fn with_settings(settings: AppSettings) -> Self {
    Self {
      settings: Mutex::new(settings),
      save_called: AtomicUsize::new(0),
    }
  }
}

impl SettingsStore for MockSettingsStore {
  fn load(&self) -> AppSettings {
    self.settings.lock().unwrap().clone()
  }

  fn save(&self, settings: &AppSettings) -> Result<(), String> {
    self.save_called.fetch_add(1, Ordering::SeqCst);
    *self.settings.lock().unwrap() = settings.clone();
    Ok(())
  }
}

struct MockTranscriber {
  transcribe_called: AtomicUsize,
  result: Mutex<Result<String, String>>,
}

impl MockTranscriber {
  fn new(result: &str) -> Self {
    Self {
      transcribe_called: AtomicUsize::new(0),
      result: Mutex::new(Ok(result.to_string())),
    }
  }

  fn with_failure(error: &str) -> Self {
    Self {
      transcribe_called: AtomicUsize::new(0),
      result: Mutex::new(Err(error.to_string())),
    }
  }
}

#[async_trait::async_trait]
impl Transcriber for MockTranscriber {
  async fn transcribe(
    &self,
    _settings: &AppSettings,
    _audio_wav: Vec<u8>,
    _prompt: Option<&str>,
  ) -> Result<String, String> {
    self.transcribe_called.fetch_add(1, Ordering::SeqCst);
    self.result.lock().unwrap().clone()
  }
}

struct MockPaster {
  paste_called: AtomicUsize,
  copy_called: AtomicUsize,
  last_text: Mutex<String>,
  last_copied_text: Mutex<String>,
  should_fail: AtomicBool,
}

impl MockPaster {
  fn new() -> Self {
    Self {
      paste_called: AtomicUsize::new(0),
      copy_called: AtomicUsize::new(0),
      last_text: Mutex::new(String::new()),
      last_copied_text: Mutex::new(String::new()),
      should_fail: AtomicBool::new(false),
    }
  }

  fn with_failure() -> Self {
    let mock = Self::new();
    mock.should_fail.store(true, Ordering::SeqCst);
    mock
  }
}

impl Paster for MockPaster {
  fn paste(&self, text: &str) -> Result<(), String> {
    self.paste_called.fetch_add(1, Ordering::SeqCst);
    *self.last_text.lock().unwrap() = text.to_string();
    if self.should_fail.load(Ordering::SeqCst) {
      return Err("Mock paste failure".to_string());
    }
    Ok(())
  }

  fn copy(&self, text: &str) -> Result<(), String> {
    self.copy_called.fetch_add(1, Ordering::SeqCst);
    *self.last_copied_text.lock().unwrap() = text.to_string();
    Ok(())
  }
}

struct MockFormatter {
  should_fail: AtomicBool,
  prefix: Mutex<String>,
}

impl MockFormatter {
  fn new() -> Self {
    Self {
      should_fail: AtomicBool::new(false),
      prefix: Mutex::new(String::new()),
    }
  }

  fn with_prefix(prefix: &str) -> Self {
    Self {
      should_fail: AtomicBool::new(false),
      prefix: Mutex::new(prefix.to_string()),
    }
  }

  fn with_failure() -> Self {
    Self {
      should_fail: AtomicBool::new(true),
      prefix: Mutex::new(String::new()),
    }
  }
}

#[async_trait::async_trait]
impl Formatter for MockFormatter {
  async fn format(
    &self,
    _base_url: &str,
    _api_key: &str,
    _model: &str,
    _system_prompt: &str,
    text: &str,
  ) -> Result<String, String> {
    if self.should_fail.load(Ordering::SeqCst) {
      return Err("Mock format failure".to_string());
    }

    Ok(format!("{}{}", self.prefix.lock().unwrap().as_str(), text))
  }
}

// ============================================================================
// Helper to create manager with mocks
// ============================================================================

fn create_manager(
  recorder: MockRecorder,
  settings_store: MockSettingsStore,
  transcriber: MockTranscriber,
  paster: MockPaster,
) -> DictationSessionManager {
  create_manager_with_formatter(
    recorder,
    settings_store,
    transcriber,
    paster,
    MockFormatter::new(),
  )
}

fn create_manager_with_formatter(
  recorder: MockRecorder,
  settings_store: MockSettingsStore,
  transcriber: MockTranscriber,
  paster: MockPaster,
  formatter: MockFormatter,
) -> DictationSessionManager {
  DictationSessionManager::new(
    Box::new(recorder),
    Box::new(settings_store),
    Box::new(transcriber),
    Box::new(paster),
    Box::new(formatter),
  )
}

fn create_default_manager() -> DictationSessionManager {
  create_manager(
    MockRecorder::new(),
    MockSettingsStore::new(),
    MockTranscriber::new("Hello world"),
    MockPaster::new(),
  )
}

// ============================================================================
// Tests: Settings
// ============================================================================

#[test]
fn test_get_settings_returns_loaded_settings() {
  let mut settings = AppSettings::default();
  settings.model = "test-model".to_string();
  settings.base_url = "https://test.api".to_string();

  let manager = create_manager(
    MockRecorder::new(),
    MockSettingsStore::with_settings(settings.clone()),
    MockTranscriber::new(""),
    MockPaster::new(),
  );

  let result = manager.get_settings().unwrap();
  assert_eq!(result.model, "test-model");
  assert_eq!(result.base_url, "https://test.api");
}

#[test]
fn test_save_settings_updates_store_and_memory() {
  let manager = create_default_manager();

  let mut new_settings = AppSettings::default();
  new_settings.model = "new-model".to_string();

  manager.save_settings(new_settings.clone()).unwrap();

  let loaded = manager.get_settings().unwrap();
  assert_eq!(loaded.model, "new-model");
}

#[test]
fn test_save_vocabulary_updates_store_and_memory() {
  let manager = create_default_manager();

  let vocabulary = vec![VocabularyEntry {
    id: "entry-1".to_string(),
    word: "Claude Code".to_string(),
    replacements: vec!["cloud code".to_string()],
    enabled: true,
  }];

  manager.save_vocabulary(vocabulary).unwrap();

  let loaded = manager.get_settings().unwrap();
  assert_eq!(loaded.vocabulary.len(), 1);
  assert_eq!(loaded.vocabulary[0].word, "Claude Code");
  assert_eq!(loaded.vocabulary[0].replacements[0], "cloud code");
  assert!(loaded.vocabulary[0].enabled);
}

// ============================================================================
// Tests: Recording Start
// ============================================================================

#[test]
fn test_start_recording_success() {
  let manager = create_default_manager();

  let mut updates = vec![];
  let result = manager.start_recording(|update| updates.push(update.state));

  assert!(result.is_ok());
  assert_eq!(updates.len(), 1);
  assert_eq!(updates[0], DictationState::Recording);
}

#[test]
fn test_start_recording_fails_when_already_recording() {
  let manager = create_default_manager();

  // Start first recording
  manager.start_recording(|_| {}).unwrap();

  // Try to start second recording
  let result = manager.start_recording(|_| {});

  assert!(result.is_err());
  assert_eq!(result.unwrap_err(), "Busy");
}

#[test]
fn test_start_recording_emits_error_on_recorder_failure() {
  let manager = create_manager(
    MockRecorder::with_start_failure(),
    MockSettingsStore::new(),
    MockTranscriber::new(""),
    MockPaster::new(),
  );

  let mut updates = vec![];
  let result = manager.start_recording(|update| updates.push(update));

  assert!(result.is_err());
  // Should emit Recording first, then Error
  assert_eq!(updates.len(), 2);
  assert_eq!(updates[0].state, DictationState::Recording);
  assert_eq!(updates[1].state, DictationState::Error);
  assert!(updates[1].message.is_some());
}

// ============================================================================
// Tests: Stop and Process (Full Flow)
// ============================================================================

#[tokio::test]
async fn test_stop_and_process_success() {
  let manager = create_manager(
    MockRecorder::new(),
    MockSettingsStore::new(),
    MockTranscriber::new("Hello world"),
    MockPaster::new(),
  );

  // Start recording first
  manager.start_recording(|_| {}).unwrap();

  // Stop and process
  let mut updates = vec![];
  let result = manager.stop_and_process(|update| updates.push(update)).await;

  assert!(result.is_ok());
  assert_eq!(result.unwrap(), "Hello world");

  // Should have: Transcribing -> Pasting -> Done
  assert_eq!(updates.len(), 3);
  assert_eq!(updates[0].state, DictationState::Transcribing);
  assert_eq!(updates[1].state, DictationState::Pasting);
  assert_eq!(updates[2].state, DictationState::Done);
  assert_eq!(updates[2].text, Some("Hello world".to_string()));
}

#[tokio::test]
async fn test_stop_and_process_fails_when_not_recording() {
  let manager = create_default_manager();

  let result = manager.stop_and_process(|_| {}).await;

  assert!(result.is_err());
  assert_eq!(result.unwrap_err(), "Not recording");
}

#[tokio::test]
async fn test_stop_and_process_handles_transcription_failure() {
  let manager = create_manager(
    MockRecorder::new(),
    MockSettingsStore::new(),
    MockTranscriber::with_failure("Transcription failed"),
    MockPaster::new(),
  );

  manager.start_recording(|_| {}).unwrap();

  let mut updates = vec![];
  let result = manager.stop_and_process(|update| updates.push(update)).await;

  assert!(result.is_err());
  assert!(result.unwrap_err().contains("Transcription failed"));

  // Should have: Transcribing -> Error
  let error_update = updates.iter().find(|u| u.state == DictationState::Error);
  assert!(error_update.is_some());
}

#[tokio::test]
async fn test_stop_and_process_handles_paste_failure() {
  let manager = create_manager(
    MockRecorder::new(),
    MockSettingsStore::new(),
    MockTranscriber::new("Hello"),
    MockPaster::with_failure(),
  );

  manager.start_recording(|_| {}).unwrap();

  let mut updates = vec![];
  let result = manager.stop_and_process(|update| updates.push(update)).await;

  assert!(result.is_err());

  // Should have error update
  let error_update = updates.iter().find(|u| u.state == DictationState::Error);
  assert!(error_update.is_some());
}

#[tokio::test]
async fn test_stop_and_process_handles_recorder_stop_failure() {
  let manager = create_manager(
    MockRecorder::with_stop_failure(),
    MockSettingsStore::new(),
    MockTranscriber::new("Hello"),
    MockPaster::new(),
  );

  manager.start_recording(|_| {}).unwrap();

  let mut updates = vec![];
  let result = manager.stop_and_process(|update| updates.push(update)).await;

  assert!(result.is_err());
  assert!(result.unwrap_err().contains("Mock stop failure"));
}

#[tokio::test]
async fn test_stop_and_process_emits_formatting_when_mode_active() {
  let mut settings = AppSettings::default();
  settings.active_mode_id = Some("mode-1".to_string());
  settings.modes = vec![Mode {
    id: "mode-1".to_string(),
    name: "Formatter".to_string(),
    system_prompt: "Format this".to_string(),
    model: "chat-model".to_string(),
  }];

  let manager = create_manager_with_formatter(
    MockRecorder::new(),
    MockSettingsStore::with_settings(settings),
    MockTranscriber::new("Hello world"),
    MockPaster::new(),
    MockFormatter::with_prefix("Formatted: "),
  );

  manager.start_recording(|_| {}).unwrap();

  let mut updates = vec![];
  let result = manager.stop_and_process(|update| updates.push(update)).await;

  assert!(result.is_ok());
  assert_eq!(result.unwrap(), "Formatted: Hello world");
  assert_eq!(updates.len(), 4);
  assert_eq!(updates[0].state, DictationState::Transcribing);
  assert_eq!(updates[1].state, DictationState::Formatting);
  assert_eq!(updates[2].state, DictationState::Pasting);
  assert_eq!(
    updates[3].text,
    Some("Formatted: Hello world".to_string())
  );
}

#[tokio::test]
async fn test_stop_and_process_falls_back_when_formatting_fails() {
  let mut settings = AppSettings::default();
  settings.active_mode_id = Some("mode-1".to_string());
  settings.modes = vec![Mode {
    id: "mode-1".to_string(),
    name: "Formatter".to_string(),
    system_prompt: "Format this".to_string(),
    model: "chat-model".to_string(),
  }];

  let manager = create_manager_with_formatter(
    MockRecorder::new(),
    MockSettingsStore::with_settings(settings),
    MockTranscriber::new("Hello world"),
    MockPaster::new(),
    MockFormatter::with_failure(),
  );

  manager.start_recording(|_| {}).unwrap();

  let mut updates = vec![];
  let result = manager.stop_and_process(|update| updates.push(update)).await;

  assert!(result.is_ok());
  assert_eq!(result.unwrap(), "Hello world");
  assert!(updates.iter().any(|update| update.state == DictationState::Formatting));
  assert_eq!(updates.last().and_then(|update| update.text.clone()), Some("Hello world".to_string()));
}

// ============================================================================
// Tests: State Transitions
// ============================================================================

#[tokio::test]
async fn test_state_returns_to_idle_after_successful_flow() {
  let manager = create_default_manager();

  manager.start_recording(|_| {}).unwrap();
  manager.stop_and_process(|_| {}).await.unwrap();

  // Should be able to start recording again
  let result = manager.start_recording(|_| {});
  assert!(result.is_ok());
}

#[tokio::test]
async fn test_state_returns_to_idle_after_error() {
  let manager = create_manager(
    MockRecorder::new(),
    MockSettingsStore::new(),
    MockTranscriber::with_failure("Error"),
    MockPaster::new(),
  );

  manager.start_recording(|_| {}).unwrap();
  let _ = manager.stop_and_process(|_| {}).await;

  // Should be able to start recording again after error
  let result = manager.start_recording(|_| {});
  assert!(result.is_ok());
}

// ============================================================================
// Tests: DictationUpdate Builder
// ============================================================================

#[test]
fn test_dictation_update_builder() {
  use super::types::DictationUpdate;

  let update = DictationUpdate::new(DictationState::Done)
    .message("Test message")
    .text("Hello world");

  assert_eq!(update.state, DictationState::Done);
  assert_eq!(update.message, Some("Test message".to_string()));
  assert_eq!(update.text, Some("Hello world".to_string()));
}

#[test]
fn test_dictation_update_without_optionals() {
  use super::types::DictationUpdate;

  let update = DictationUpdate::new(DictationState::Recording);

  assert_eq!(update.state, DictationState::Recording);
  assert!(update.message.is_none());
  assert!(update.text.is_none());
}
