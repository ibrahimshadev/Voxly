use crate::domain::{
  impls::{ClipboardPaster, CpalRecorder, FileAndKeyringSettingsStore, OpenAiCompatibleTranscriber},
  manager::DictationSessionManager,
};

pub struct AppState {
  pub manager: DictationSessionManager,
}

impl Default for AppState {
  fn default() -> Self {
    Self {
      manager: DictationSessionManager::new(
        Box::new(CpalRecorder::default()),
        Box::new(FileAndKeyringSettingsStore),
        Box::new(OpenAiCompatibleTranscriber),
        Box::new(ClipboardPaster),
      ),
    }
  }
}
